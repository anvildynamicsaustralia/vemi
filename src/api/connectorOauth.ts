/**
 * Letting a person's own Claude or ChatGPT in: the OAuth side of the connector.
 *
 * VEMI is both the server that guards `/mcp` and the one that says who may pass, on one
 * origin. An app is let in by the person's Allow, never by anything it sends alone. The
 * pieces, in the order an app meets them:
 *
 *  - the two metadata documents it reads to find the rest;
 *  - registration, either by `POST /oauth/register` or by being named with an address whose
 *    page tells VEMI who it is (a client metadata document);
 *  - `GET /oauth/authorize`, which checks the request and hands the person on to the consent
 *    page, keeping everything the app asked;
 *  - `POST /api/connector/consent` (in `app.ts`, behind the session and the Origin check),
 *    which takes the person's answer and says where to send them back;
 *  - `POST /oauth/token`, which trades the code, or a refresh token, for tokens.
 *
 * Nothing is remembered between the authorize and the consent: the consent carries the
 * request whole and it is checked again, so there is no pending row to expire or to fill.
 * Only hashes of codes and tokens are kept (the store sees nothing else). A token is good for
 * one resource, `/mcp` on this origin, and for the one person who allowed it.
 */
import { capBody } from "./body.js";
import type { ConnectorClient, ConnectorGrant, Store } from "./store.js";
import { parseClientMetadata, parseConsent, redirectAllowed, sentJson, type Parsed } from "./validate.js";

export interface ConnectorDeps {
  readonly store: Store;
  /** The page's own origin: the issuer, and where `/mcp` lives. */
  readonly origin: string;
  readonly now: () => Date;
  /** How an app's client metadata document is read. */
  readonly fetch: typeof fetch;
}

export interface Connector {
  /** Answers the connector's own paths, or null for any other. Runs before the Origin and cookie checks. */
  handle(request: Request): Promise<Response | null>;
  /** The grant a request's bearer token stands for, or null: unknown, expired, revoked, or not sent as a header. */
  bearer(request: Request): Promise<ConnectorGrant | null>;
  /** The registered name of the app a request names, or null when the app or its return address is not known. Stores nothing. */
  client(clientId: string, redirectUri: string): Promise<string | null>;
  /** The person's answer to a pending request, as `POST /api/connector/consent` takes it. */
  consent(owner: string, body: unknown): Promise<Response>;
}

const ACCESS_MINUTES = 60;
const CODE_MINUTES = 10;
const CLIENT_DOC_MAX = 5_000;
/** Apps may register this many times an hour from one address, and all together this many. */
const REGISTER_PER_ADDRESS = 60;
const REGISTER_IN_ALL = 600;
const HOUR_MS = 3_600_000;
const FORM_MAX = 8_000;
const REGISTER_BODY_MAX = 20_000;

const CHALLENGE = /^[A-Za-z0-9_-]{43,128}$/;
const VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/;

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
  });
}

const oauthError = (status: number, error: string, description: string): Response =>
  json(status, { error, error_description: description });

const toHex = (bytes: ArrayBuffer): string => [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");

async function sha256Hex(text: string): Promise<string> {
  return toHex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
}

/** The caller as the edge saw it; one shared name when it did not say. */
const addressOf = (request: Request): string => request.headers.get("cf-connecting-ip") ?? "unknown";

function b64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** A secret nobody can guess: 32 random bytes. */
function secret(): string {
  return b64url(crypto.getRandomValues(new Uint8Array(32)));
}

/**
 * A response body as text, or null once it is past `max` characters. A content-length over the
 * limit refuses before a byte is read; otherwise the body is read in pieces and dropped the
 * moment the limit is passed, so a hostile page cannot make this hold more than a piece over.
 */
async function readCapped(res: Response, max: number): Promise<string | null> {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > max) { await res.body?.cancel(); return null; }
  if (res.body === null) return "";
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let bytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > max) { await reader.cancel(); return null; }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

/** The address an app uses as its id when it publishes its own metadata: HTTPS, a real name, a path. */
function isClientDocument(id: string): boolean {
  let u: URL;
  try { u = new URL(id); } catch { return false; }
  if (u.protocol !== "https:" || u.port !== "" || u.pathname === "/" || u.username !== "" || u.hash !== "") return false;
  const name = u.hostname;
  if (name.includes(":") || /^\d+(\.\d+){3}$/.test(name) || !name.includes(".")) return false;
  return !/\.(local|localhost|internal|lan|home)$/.test(name);
}

export function createConnector(deps: ConnectorDeps): Connector {
  const { store } = deps;
  const origin = deps.origin.replace(/\/+$/, "");
  const resource = `${origin}/mcp`;
  const resourceMetadata = `${origin}/.well-known/oauth-protected-resource/mcp`;
  const minutesOn = (minutes: number): string => new Date(deps.now().getTime() + minutes * 60_000).toISOString();

  /** An app's own page about itself, fetched with a short leash: HTTPS, no redirect, small, quick. */
  async function readClientDocument(id: string): Promise<ConnectorClient | null> {
    if (!isClientDocument(id)) return null;
    try {
      const res = await deps.fetch(id, { redirect: "error", headers: { accept: "application/json" }, signal: AbortSignal.timeout(5_000) });
      if (!res.ok) return null;
      const body = await readCapped(res, CLIENT_DOC_MAX);
      if (body === null) return null;
      const doc = JSON.parse(body) as Record<string, unknown>;
      if (doc.client_id !== id) return null;
      const meta = parseClientMetadata(doc);
      if (!meta.ok) return null;
      return { id, name: meta.value.name, redirectUris: meta.value.redirectUris };
    } catch {
      return null;
    }
  }

  /**
   * Counts one registration against this address and against everyone, unless one is at its
   * limit: then false and nothing is counted. Uses the table sign-in attempts use.
   */
  async function mayRegister(address: string): Promise<boolean> {
    const at = deps.now();
    const keyOf = async (kind: string): Promise<string> => sha256Hex(`vemi-throttle:connector-register:${kind}`);
    const { reserved } = await store.attempt(
      null,
      [{ key: await sha256Hex(`vemi-throttle:connector-register:ip:${address}`), limit: REGISTER_PER_ADDRESS }, { key: await keyOf("all"), limit: REGISTER_IN_ALL }],
      at.toISOString(), new Date(at.getTime() - HOUR_MS).toISOString(), new Date(at.getTime() - HOUR_MS).toISOString(),
    );
    return reserved !== null;
  }

  /**
   * The client a request names, learned from its page when its id is one; null when unknown.
   * With an `address` (an app, not yet a person at the consent page), a page not yet known is
   * counted against the registration limit before it is fetched; null when over it.
   */
  async function clientFor(id: string, address: string | null = null): Promise<ConnectorClient | null> {
    if (isClientDocument(id)) {
      if (address !== null && await store.client(id) === null && !(await mayRegister(address))) return null;
      const doc = await readClientDocument(id);
      if (doc === null) return null;
      await store.registerClient(doc);
      return doc;
    }
    return store.client(id);
  }

  interface Ask {
    readonly client: ConnectorClient;
    readonly redirectUri: string;
  }

  /** Who is asking and where to send the person back. Nothing else is trusted until this holds. */
  async function whoAsks(clientId: string, redirectUri: string, address: string | null = null): Promise<Ask | null> {
    if (clientId === "" || redirectUri === "") return null;
    const client = await clientFor(clientId, address);
    if (client === null || !redirectAllowed(client.redirectUris, redirectUri)) return null;
    return { client, redirectUri };
  }

  /** What the app asked beyond who it is: null when fine, else the OAuth error to tell it. */
  function faultIn(challenge: string | null, method: string | null, asked: string | null): { error: string; description: string } | null {
    if (challenge === null || !CHALLENGE.test(challenge)) return { error: "invalid_request", description: "a PKCE code_challenge is required" };
    if (method !== null && method !== "S256") return { error: "invalid_request", description: "code_challenge_method must be S256" };
    if (asked !== null && asked !== resource) return { error: "invalid_target", description: "the resource is not this server" };
    return null;
  }

  function backTo(redirectUri: string, params: Record<string, string | null>): string {
    const to = new URL(redirectUri);
    for (const [key, value] of Object.entries(params)) if (value !== null) to.searchParams.set(key, value);
    to.searchParams.set("iss", origin);
    return to.toString();
  }

  async function authorize(request: Request, url: URL): Promise<Response> {
    const q = url.searchParams;
    const ask = await whoAsks(q.get("client_id") ?? "", q.get("redirect_uri") ?? "", addressOf(request));
    if (ask === null) return oauthError(400, "invalid_request", "client_id or redirect_uri is not one this server knows");
    const state = q.get("state");
    const refuse = (error: string, description: string): Response =>
      new Response(null, { status: 302, headers: { location: backTo(ask.redirectUri, { error, error_description: description, state }), "cache-control": "no-store" } });
    if (q.get("response_type") !== "code") return refuse("unsupported_response_type", "response_type must be code");
    const fault = faultIn(q.get("code_challenge"), q.get("code_challenge_method"), q.get("resource"));
    if (fault !== null) return refuse(fault.error, fault.description);

    const to = new URL(`${origin}/connect`);
    to.searchParams.set("client_id", ask.client.id);
    to.searchParams.set("redirect_uri", ask.redirectUri);
    to.searchParams.set("code_challenge", q.get("code_challenge") ?? "");
    if (state !== null) to.searchParams.set("state", state);
    to.searchParams.set("resource", resource);
    return new Response(null, { status: 302, headers: { location: to.toString(), "cache-control": "no-store" } });
  }

  async function consent(owner: string, body: unknown): Promise<Response> {
    const parsed = parseConsent(body);
    if (!parsed.ok) return json(400, { error: parsed.error });
    const c = parsed.value;
    const ask = await whoAsks(c.clientId, c.redirectUri);
    if (ask === null) return json(400, { error: "that app or its return address is not one this server knows" });
    if (c.decision === "deny") {
      return json(200, { redirect: backTo(ask.redirectUri, { error: "access_denied", error_description: "the person said no", state: c.state }) });
    }
    const fault = faultIn(c.codeChallenge, "S256", c.resource);
    if (fault !== null) return json(400, { error: fault.description });
    const code = secret();
    await store.putCode(owner, {
      hash: await sha256Hex(code), clientId: ask.client.id, challenge: c.codeChallenge, redirectUri: ask.redirectUri, expiresAt: minutesOn(CODE_MINUTES),
    });
    return json(200, { redirect: backTo(ask.redirectUri, { code, state: c.state }) });
  }

  async function register(request: Request): Promise<Response> {
    if (!(await mayRegister(addressOf(request)))) return oauthError(429, "temporarily_unavailable", "too many registrations: try again later");
    if (!sentJson(request)) return oauthError(415, "invalid_client_metadata", "send JSON, with content-type: application/json");
    const capped = await capBody(request, REGISTER_BODY_MAX);
    if (!capped.ok) return oauthError(413, "invalid_client_metadata", "the request is too large");
    let body: unknown;
    try { body = JSON.parse(capped.text); } catch { return oauthError(400, "invalid_client_metadata", "the body is not valid JSON"); }
    const meta: Parsed<{ name: string; redirectUris: string[] }> = parseClientMetadata(body);
    if (!meta.ok) return oauthError(400, "invalid_redirect_uri", meta.error);
    const id = `c_${crypto.randomUUID()}`;
    await store.registerClient({ id, name: meta.value.name, redirectUris: meta.value.redirectUris });
    return json(201, {
      client_id: id, client_name: meta.value.name, redirect_uris: meta.value.redirectUris,
      token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"],
    });
  }

  async function issue(owner: string, clientId: string): Promise<Response> {
    const access = secret();
    const refresh = secret();
    await store.issueGrant(owner, {
      clientId, tokenHash: await sha256Hex(access), refreshHash: await sha256Hex(refresh), expiresAt: minutesOn(ACCESS_MINUTES),
    });
    return tokens(access, refresh);
  }

  const tokens = (access: string, refresh: string): Response =>
    json(200, { access_token: access, token_type: "Bearer", expires_in: ACCESS_MINUTES * 60, refresh_token: refresh }, { pragma: "no-cache" });

  async function token(request: Request): Promise<Response> {
    const capped = await capBody(request, FORM_MAX);
    if (!capped.ok) return oauthError(400, "invalid_request", "the request is too large");
    const f = new URLSearchParams(capped.text);
    const grantType = f.get("grant_type");
    if (grantType !== "authorization_code" && grantType !== "refresh_token") {
      return oauthError(400, "unsupported_grant_type", "grant_type must be authorization_code or refresh_token");
    }
    const clientId = f.get("client_id") ?? "";
    if (clientId === "") return oauthError(400, "invalid_request", "client_id is required");
    const asked = f.get("resource");
    if (asked !== null && asked !== resource) return oauthError(400, "invalid_target", "the resource is not this server");

    if (grantType === "refresh_token") {
      const refresh = f.get("refresh_token") ?? "";
      if (refresh === "") return oauthError(400, "invalid_request", "refresh_token is required");
      const access = secret();
      const next = secret();
      // The app is named in the same statement that rotates, so a wrong client_id spends nothing.
      const grant = await store.rotateGrant(await sha256Hex(refresh), clientId, {
        tokenHash: await sha256Hex(access), refreshHash: await sha256Hex(next), expiresAt: minutesOn(ACCESS_MINUTES),
      });
      if (grant === null) return oauthError(400, "invalid_grant", "the refresh token is not good");
      return tokens(access, next);
    }

    const code = f.get("code") ?? "";
    const verifier = f.get("code_verifier") ?? "";
    const redirectUri = f.get("redirect_uri") ?? "";
    if (code === "" || redirectUri === "") return oauthError(400, "invalid_request", "code and redirect_uri are required");
    if (!VERIFIER.test(verifier)) return oauthError(400, "invalid_request", "code_verifier is required");
    // Taking the code spends it, so a wrong guess at the rest cannot be tried again.
    const held = await store.takeCode(await sha256Hex(code));
    const bad = oauthError(400, "invalid_grant", "the code is not good");
    if (held === null || held.clientId !== clientId || held.redirectUri !== redirectUri) return bad;
    if (b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)))) !== held.challenge) return bad;
    return issue(held.owner, held.clientId);
  }

  async function bearer(request: Request): Promise<ConnectorGrant | null> {
    const given = /^Bearer +(\S+)$/i.exec(request.headers.get("authorization") ?? "")?.[1];
    if (given === undefined) return null;
    return store.grantByToken(await sha256Hex(given));
  }

  const metadata = (body: unknown): Response => json(200, body, { "cache-control": "public, max-age=3600" });
  const only = (method: string, request: Request): Response | null =>
    request.method === method ? null : json(405, { error: `${method} only` }, { allow: method });

  async function handle(request: Request): Promise<Response | null> {
    const url = new URL(request.url);
    switch (url.pathname) {
      case "/.well-known/oauth-protected-resource":
      case "/.well-known/oauth-protected-resource/mcp":
        return only("GET", request) ?? metadata({ resource, authorization_servers: [origin], bearer_methods_supported: ["header"] });
      case "/.well-known/oauth-authorization-server":
        return only("GET", request) ?? metadata({
          issuer: origin,
          authorization_endpoint: `${origin}/oauth/authorize`,
          token_endpoint: `${origin}/oauth/token`,
          registration_endpoint: `${origin}/oauth/register`,
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code", "refresh_token"],
          code_challenge_methods_supported: ["S256"],
          token_endpoint_auth_methods_supported: ["none"],
          client_id_metadata_document_supported: true,
          authorization_response_iss_parameter_supported: true,
        });
      case "/oauth/register":
        return only("POST", request) ?? register(request);
      case "/oauth/authorize":
        return only("GET", request) ?? authorize(request, url);
      case "/oauth/token":
        return only("POST", request) ?? token(request);
      case "/mcp":
        if (await bearer(request) !== null) return null;
        return json(401, { error: "Allow this app from your VEMI account first." }, { "www-authenticate": `Bearer resource_metadata="${resourceMetadata}"` });
      default:
        return null;
    }
  }

  async function client(clientId: string, redirectUri: string): Promise<string | null> {
    return (await whoAsks(clientId, redirectUri))?.client.name ?? null;
  }

  return { handle, bearer, consent, client };
}
