import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp, type App } from "./app.js";
import { accountIdentity } from "./accountIdentity.js";
import { createConnector, type Connector } from "./connectorOauth.js";
import { hashPassword } from "./password.js";
import { openStore, type Store } from "./store.js";
import { testDb, type TestDb } from "./testing/d1.js";

/** The OAuth endpoints for the connector, through the real routes and a real D1. */

const ORIGIN = "https://vemi.example.workers.dev";
const MCP = `${ORIGIN}/mcp`;
const PASSWORD = "a long enough password";
const REDIRECT = "https://claude.example/api/mcp/auth_callback";
const CIMD = "https://chat.example/client.json";

let t: TestDb;
let store: Store;
let app: App;
let connector: Connector;
let passwordHash: string;
let now = new Date("2026-11-18T02:00:00Z");
let published: unknown = { client_id: CIMD, client_name: "Chat", redirect_uris: ["https://chat.example/cb"] };

const outbound = async (input: RequestInfo | URL): Promise<Response> => {
  if (String(input) !== CIMD) throw new Error("a test reached the network");
  return Response.json(published);
};

beforeAll(async () => {
  t = await testDb();
  passwordHash = await hashPassword(PASSWORD);
  store = openStore({ DB: t.db }, () => now);
  const identity = accountIdentity({
    store, now: () => now, origin: ORIGIN, owner: "the-operator", operatorEmail: "",
    sessionSecret: "session-secret", google: null,
    fetch: async () => { throw new Error("a test reached the network"); },
  });
  app = createApp({
    store, now: () => now, origin: ORIGIN, timeZone: "Australia/Sydney", identity, fetch: outbound,
    live: { publish: async () => {}, connect: async () => new Response("connected") },
  });
  connector = createConnector({ store, origin: ORIGIN, now: () => now, fetch: outbound });
});
afterAll(() => t.dispose());

const b64url = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const verifierOf = (): string => b64url(crypto.getRandomValues(new Uint8Array(32)));
const challengeOf = async (v: string): Promise<string> => b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(v))));

interface Person {
  readonly owner: string;
  readonly call: (method: string, path: string, body?: unknown, origin?: boolean) => Promise<Response>;
  readonly anon: (method: string, path: string, body?: unknown) => Promise<Response>;
}

const anon: Person["anon"] = (method, path, body) => app(
  new Request(`${ORIGIN}${path}`, { method, headers: body === undefined ? {} : { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }),
  () => {},
);

async function person(): Promise<Person> {
  const owner = `owner-${crypto.randomUUID()}`;
  const email = `${owner}@example.test`;
  expect(await store.createAccount({ id: owner, email, passwordHash, googleSub: null, confirmed: true })).toBe(true);
  let cookie = "";
  const call: Person["call"] = (method, path, body, origin = true) => app(
    new Request(`${ORIGIN}${path}`, {
      method,
      headers: { ...(origin ? { origin: ORIGIN } : {}), ...(cookie ? { cookie } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    () => {},
  );
  const signedIn = await call("POST", "/auth/sign-in", { email, password: PASSWORD });
  expect(signedIn.status).toBe(200);
  cookie = (signedIn.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  return { owner, call, anon };
}

async function register(redirectUris: string[] = [REDIRECT]): Promise<string> {
  const res = await anon("POST", "/oauth/register", { client_name: "Claude", redirect_uris: redirectUris });
  expect(res.status).toBe(201);
  return ((await res.json()) as { client_id: string }).client_id;
}

interface Ask { clientId: string; redirectUri: string; verifier: string; challenge: string; state: string }
async function ask(clientId: string, redirectUri = REDIRECT): Promise<Ask> {
  const verifier = verifierOf();
  return { clientId, redirectUri, verifier, challenge: await challengeOf(verifier), state: `s-${crypto.randomUUID()}` };
}

const consentBody = (a: Ask, decision: "allow" | "deny") => ({
  decision, clientId: a.clientId, redirectUri: a.redirectUri, codeChallenge: a.challenge, state: a.state, resource: MCP,
});

/** Allow, then the code the app is sent back with. */
async function allow(p: Person, a: Ask): Promise<string> {
  const res = await p.call("POST", "/api/connector/consent", consentBody(a, "allow"));
  expect(res.status).toBe(200);
  const back = new URL(((await res.json()) as { redirect: string }).redirect);
  expect(back.origin + back.pathname).toBe(a.redirectUri);
  expect(back.searchParams.get("state")).toBe(a.state);
  expect(back.searchParams.get("iss")).toBe(ORIGIN);
  return back.searchParams.get("code") ?? "";
}

const form = (fields: Record<string, string>): RequestInit => ({
  method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(fields).toString(),
});
const token = (fields: Record<string, string>): Promise<Response> => app(new Request(`${ORIGIN}/oauth/token`, form(fields)), () => {});
const exchange = (a: Ask, code: string, over: Record<string, string> = {}): Promise<Response> =>
  token({ grant_type: "authorization_code", code, code_verifier: a.verifier, redirect_uri: a.redirectUri, client_id: a.clientId, resource: MCP, ...over });

interface Tokens { access_token: string; refresh_token: string; token_type: string; expires_in: number }

async function signedUp(p: Person, redirectUri = REDIRECT): Promise<{ a: Ask; tokens: Tokens }> {
  const a = await ask(await register([redirectUri]), redirectUri);
  const res = await exchange(a, await allow(p, a));
  expect(res.status).toBe(200);
  return { a, tokens: (await res.json()) as Tokens };
}

const mcp = (access?: string): Promise<Response> =>
  app(new Request(MCP, { method: "POST", headers: access === undefined ? {} : { authorization: `Bearer ${access}` }, body: "{}" }), () => {});

describe("the metadata documents", () => {
  it("names the resource, and the server that guards it", async () => {
    for (const path of ["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"]) {
      const res = await anon("GET", path);
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ resource: MCP, authorization_servers: [ORIGIN], bearer_methods_supported: ["header"] });
    }
    const res = await anon("GET", "/.well-known/oauth-authorization-server");
    expect(await res.json()).toMatchObject({
      issuer: ORIGIN, authorization_endpoint: `${ORIGIN}/oauth/authorize`, token_endpoint: `${ORIGIN}/oauth/token`,
      registration_endpoint: `${ORIGIN}/oauth/register`, code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"], client_id_metadata_document_supported: true,
      authorization_response_iss_parameter_supported: true,
    });
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });
});

describe("/mcp", () => {
  it("answers 401 with where to find the metadata, to a request with no cookie and no Origin", async () => {
    for (const res of [await mcp(), await mcp("not-a-token")]) {
      expect(res.status).toBe(401);
      expect(res.headers.get("www-authenticate")).toBe(`Bearer resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/mcp"`);
      expect(res.headers.get("cache-control")).toBe("no-store");
    }
  });
});

describe("registration", () => {
  it("makes a client of a name and its return addresses", async () => {
    const id = await register();
    expect(await store.client(id)).toMatchObject({ name: "Claude", redirectUris: [REDIRECT] });
  });

  it("refuses an address that is not https or loopback", async () => {
    for (const bad of ["http://claude.example/cb", "javascript:alert(1)", "https://claude.example/cb#x"]) {
      const res = await anon("POST", "/oauth/register", { client_name: "X", redirect_uris: [bad] });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe("invalid_redirect_uri");
    }
    expect((await anon("POST", "/oauth/register", { client_name: "X" })).status).toBe(400);
  });
});

describe("/oauth/authorize", () => {
  const url = (a: Ask, over: Record<string, string | null> = {}): string => {
    const q = new URLSearchParams({
      response_type: "code", client_id: a.clientId, redirect_uri: a.redirectUri, code_challenge: a.challenge,
      code_challenge_method: "S256", state: a.state, resource: MCP,
    });
    for (const [k, v] of Object.entries(over)) { if (v === null) q.delete(k); else q.set(k, v); }
    return `${ORIGIN}/oauth/authorize?${q}`;
  };
  const get = (u: string): Promise<Response> => app(new Request(u), () => {});

  it("sends a good request on to the consent page, with the request intact", async () => {
    const a = await ask(await register());
    const res = await get(url(a));
    expect(res.status).toBe(302);
    const to = new URL(res.headers.get("location") ?? "");
    expect(to.origin + to.pathname).toBe(`${ORIGIN}/connect`);
    expect(to.searchParams.get("client_id")).toBe(a.clientId);
    expect(to.searchParams.get("redirect_uri")).toBe(a.redirectUri);
    expect(to.searchParams.get("code_challenge")).toBe(a.challenge);
    expect(to.searchParams.get("state")).toBe(a.state);
  });

  it("will not send a person back to an address the app never named", async () => {
    const a = await ask(await register());
    const res = await get(url(a, { redirect_uri: "https://evil.example/cb" }));
    expect(res.status).toBe(400);
    expect(res.headers.get("location")).toBeNull();
    expect((await get(url(a, { client_id: "nobody" }))).status).toBe(400);
  });

  it("tells the app, at its own address, when PKCE S256 is missing or the resource is not ours", async () => {
    const a = await ask(await register());
    const overs: Record<string, string | null>[] = [{ code_challenge: null },{ code_challenge_method: "plain" }, { resource: "https://elsewhere.example/mcp" }, { response_type: "token" }];
    for (const over of overs) {
      const res = await get(url(a, over));
      expect(res.status).toBe(302);
      const to = new URL(res.headers.get("location") ?? "");
      expect(to.origin + to.pathname).toBe(REDIRECT);
      expect(to.searchParams.get("error")).toMatch(/^(invalid_request|invalid_target|unsupported_response_type)$/);
      expect(to.searchParams.get("state")).toBe(a.state);
    }
  });

  it("learns a client from the page its id names, and checks the address against it", async () => {
    published = { client_id: CIMD, client_name: "Chat", redirect_uris: ["https://chat.example/cb"] };
    const a = await ask(CIMD, "https://chat.example/cb");
    expect((await get(url(a))).status).toBe(302);
    expect(await store.client(CIMD)).toMatchObject({ name: "Chat" });
    expect((await get(url({ ...a, redirectUri: "https://chat.example/other" }))).status).toBe(400);
    published = { client_id: "https://chat.example/different.json", client_name: "Chat", redirect_uris: ["https://chat.example/cb"] };
    expect((await get(url(a))).status).toBe(400);
  });

  it("will not fetch from a private address", async () => {
    const a = await ask("https://127.0.0.1/client.json");
    expect((await get(url(a))).status).toBe(400);
  });
});

describe("GET /api/connector/client", () => {
  const q = (id: string, uri: string): string => `/api/connector/client?id=${encodeURIComponent(id)}&redirect_uri=${encodeURIComponent(uri)}`;

  it("names a registered app whose address was registered, and stores nothing", async () => {
    const p = await person();
    const id = await register();
    const res = await p.call("GET", q(id, REDIRECT));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ name: "Claude" });
    expect(await store.grants(p.owner)).toEqual([]);
  });

  it("names an app that publishes its own page", async () => {
    const p = await person();
    published = { client_id: CIMD, client_name: "Chat", redirect_uris: ["https://chat.example/cb"] };
    const res = await p.call("GET", q(CIMD, "https://chat.example/cb"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ name: "Chat" });
  });

  it("answers 404 for an unknown app, an unregistered address, or a missing part", async () => {
    const p = await person();
    const id = await register();
    expect((await p.call("GET", q("c_nobody", REDIRECT))).status).toBe(404);
    expect((await p.call("GET", q(id, "https://evil.example/cb"))).status).toBe(404);
    expect((await p.call("GET", `/api/connector/client?id=${id}`)).status).toBe(404);
  });

  it("needs a session", async () => {
    const id = await register();
    expect((await anon("GET", q(id, REDIRECT))).status).toBe(401);
  });
});

describe("/api/connector/consent", () => {
  it("needs a session and the page's Origin", async () => {
    const p = await person();
    const a = await ask(await register());
    expect((await anon("POST", "/api/connector/consent", consentBody(a, "allow"))).status).toBe(403);
    expect((await p.call("POST", "/api/connector/consent", consentBody(a, "allow"), false)).status).toBe(403);
    const noSession = await app(new Request(`${ORIGIN}/api/connector/consent`, {
      method: "POST", headers: { origin: ORIGIN, "content-type": "application/json" }, body: JSON.stringify(consentBody(a, "allow")),
    }), () => {});
    expect(noSession.status).toBe(401);
  });

  it("answers deny with access_denied at the app's address", async () => {
    const p = await person();
    const a = await ask(await register());
    const res = await p.call("POST", "/api/connector/consent", consentBody(a, "deny"));
    expect(res.status).toBe(200);
    const back = new URL(((await res.json()) as { redirect: string }).redirect);
    expect(back.searchParams.get("error")).toBe("access_denied");
    expect(back.searchParams.get("state")).toBe(a.state);
    expect(back.searchParams.get("code")).toBeNull();
    expect(await store.grants(p.owner)).toEqual([]);
  });

  it("refuses an address the app never named, even from a signed-in person", async () => {
    const p = await person();
    const a = await ask(await register());
    const res = await p.call("POST", "/api/connector/consent", consentBody({ ...a, redirectUri: "https://evil.example/cb" }, "allow"));
    expect(res.status).toBe(400);
  });

  it("refuses a body with a key it does not know", async () => {
    const p = await person();
    const a = await ask(await register());
    expect((await p.call("POST", "/api/connector/consent", { ...consentBody(a, "allow"), owner: "x" })).status).toBe(400);
  });
});

describe("/oauth/token", () => {
  it("trades an allowed code for tokens, once", async () => {
    const p = await person();
    const a = await ask(await register());
    const code = await allow(p, a);
    const res = await exchange(a, code);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const tokens = (await res.json()) as Tokens;
    expect(tokens).toMatchObject({ token_type: "Bearer", expires_in: 3600 });
    expect(tokens.access_token).not.toBe(tokens.refresh_token);
    expect((await store.grants(p.owner))).toHaveLength(1);

    const again = await exchange(a, code);
    expect(again.status).toBe(400);
    expect(await again.json()).toMatchObject({ error: "invalid_grant" });
  });

  it("refuses a wrong PKCE verifier, and the code is spent", async () => {
    const p = await person();
    const a = await ask(await register());
    const code = await allow(p, a);
    const bad = await exchange(a, code, { code_verifier: verifierOf() });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ error: "invalid_grant" });
    expect((await exchange(a, code)).status).toBe(400);
    expect(await store.grants(p.owner)).toEqual([]);
  });

  it("refuses a code that has expired", async () => {
    const p = await person();
    const a = await ask(await register());
    const code = await allow(p, a);
    const was = now;
    now = new Date(now.getTime() + 11 * 60_000);
    try {
      const res = await exchange(a, code);
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: "invalid_grant" });
    } finally {
      now = was;
    }
  });

  it("refuses a different return address than the one the code was made for", async () => {
    const p = await person();
    const a = await ask(await register([REDIRECT, "https://claude.example/other"]));
    const code = await allow(p, a);
    const res = await exchange(a, code, { redirect_uri: "https://claude.example/other" });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "invalid_grant" });
  });

  it("refuses a code made for another client", async () => {
    const p = await person();
    const a = await ask(await register());
    const other = await register();
    const code = await allow(p, a);
    expect((await exchange(a, code, { client_id: other })).status).toBe(400);
  });

  it("refuses a resource that is not this server's", async () => {
    const p = await person();
    const a = await ask(await register());
    const code = await allow(p, a);
    const res = await exchange(a, code, { resource: "https://elsewhere.example/mcp" });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "invalid_target" });
  });

  it("refuses a grant type it does not do, and a request with no body", async () => {
    expect(await (await token({ grant_type: "password" })).json()).toMatchObject({ error: "unsupported_grant_type" });
    expect((await token({})).status).toBe(400);
  });

  it("rotates the refresh token: the new one works, the old one is dead", async () => {
    const p = await person();
    const { a, tokens } = await signedUp(p);
    const res = await token({ grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: a.clientId, resource: MCP });
    expect(res.status).toBe(200);
    const next = (await res.json()) as Tokens;
    expect(next.refresh_token).not.toBe(tokens.refresh_token);
    expect(next.access_token).not.toBe(tokens.access_token);

    const old = await token({ grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: a.clientId });
    expect(old.status).toBe(400);
    expect(await old.json()).toMatchObject({ error: "invalid_grant" });
    expect((await token({ grant_type: "refresh_token", refresh_token: next.refresh_token, client_id: a.clientId })).status).toBe(200);
  });

  it("refuses a refresh token shown by another client", async () => {
    const p = await person();
    const { tokens } = await signedUp(p);
    const other = await register();
    const res = await token({ grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: other });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "invalid_grant" });
  });
});

describe("a token", () => {
  it("opens /mcp to the one who holds it, and its owner is the person who allowed", async () => {
    const p = await person();
    const { tokens } = await signedUp(p);
    const request = new Request(MCP, { method: "POST", headers: { authorization: `Bearer ${tokens.access_token}` } });
    const grant = await connector.bearer(request);
    expect(grant?.owner).toBe(p.owner);
    expect((await mcp(tokens.access_token)).status).not.toBe(401);
  });

  it("never reaches another account", async () => {
    const a = await person();
    const b = await person();
    const one = await signedUp(a);
    const two = await signedUp(b);
    const owner = async (access: string) => (await connector.bearer(new Request(MCP, { headers: { authorization: `Bearer ${access}` } })))?.owner;
    expect(await owner(one.tokens.access_token)).toBe(a.owner);
    expect(await owner(two.tokens.access_token)).toBe(b.owner);
    expect((await store.grants(a.owner)).map((g) => g.owner)).toEqual([a.owner]);
  });

  it("stops working once revoked", async () => {
    const p = await person();
    const { tokens, a } = await signedUp(p);
    expect((await mcp(tokens.access_token)).status).not.toBe(401);
    const [grant] = await store.grants(p.owner);
    expect(await store.revokeGrant(p.owner, grant?.id ?? "")).toBe(true);
    expect((await mcp(tokens.access_token)).status).toBe(401);
    const refreshed = await token({ grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: a.clientId });
    expect(refreshed.status).toBe(400);
  });

  it("stops working when it has run out", async () => {
    const p = await person();
    const { tokens } = await signedUp(p);
    const was = now;
    now = new Date(now.getTime() + 61 * 60_000);
    try {
      expect((await mcp(tokens.access_token)).status).toBe(401);
    } finally {
      now = was;
    }
  });

  it("is not read from the query string", async () => {
    const p = await person();
    const { tokens } = await signedUp(p);
    const res = await app(new Request(`${MCP}?access_token=${tokens.access_token}`, { method: "POST" }), () => {});
    expect(res.status).toBe(401);
  });
});

describe("the default outbound fetch", () => {
  it("reads a client page through the runtime fetch without a borrowed this", async () => {
    const real = globalThis.fetch;
    globalThis.fetch = function (this: unknown): Promise<Response> {
      if (this !== undefined && this !== globalThis) throw new TypeError("Illegal invocation");
      return Promise.resolve(Response.json({ client_id: CIMD, client_name: "Chat", redirect_uris: ["https://chat.example/cb"] }));
    } as typeof fetch;
    try {
      const plain = createApp({
        store, now: () => now, origin: ORIGIN, timeZone: "Australia/Sydney",
        identity: accountIdentity({
          store, now: () => now, origin: ORIGIN, owner: "the-operator", operatorEmail: "",
          sessionSecret: "session-secret", google: null,
          fetch: async () => { throw new Error("a test reached the network"); },
        }),
        live: { publish: async () => {}, connect: async () => new Response("connected") },
      });
      const q = new URLSearchParams({
        response_type: "code", client_id: CIMD, redirect_uri: "https://chat.example/cb", code_challenge: "x".repeat(43),
        code_challenge_method: "S256", state: "s", resource: MCP,
      });
      const res = await plain(new Request(`${ORIGIN}/oauth/authorize?${q}`), () => {});
      expect(res.status).toBe(302);
    } finally {
      globalThis.fetch = real;
    }
  });
});

describe("a refresh by the wrong app", () => {
  it("answers invalid_grant and leaves the real app's refresh token working", async () => {
    const p = await person();
    const { a, tokens } = await signedUp(p);
    const other = await register();
    const bad = await token({ grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: other });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ error: "invalid_grant" });
    const good = await token({ grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: a.clientId });
    expect(good.status).toBe(200);
  });

  it("answers invalid_grant once the 30 days have passed", async () => {
    const p = await person();
    const { a, tokens } = await signedUp(p);
    const was = now;
    now = new Date(now.getTime() + 31 * 86_400_000);
    try {
      const res = await token({ grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: a.clientId });
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: "invalid_grant" });
    } finally {
      now = was;
    }
  });
});

describe("registration is limited", () => {
  const from = (address: string): Promise<Response> => app(
    new Request(`${ORIGIN}/oauth/register`, {
      method: "POST", headers: { "content-type": "application/json", "cf-connecting-ip": address },
      body: JSON.stringify({ client_name: "Flood", redirect_uris: [REDIRECT] }),
    }),
    () => {},
  );

  it("answers 429 after 60 an hour from one address, and another address is still served", async () => {
    for (let i = 0; i < 60; i += 1) expect((await from("198.51.100.7")).status).toBe(201);
    const over = await from("198.51.100.7");
    expect(over.status).toBe(429);
    expect(await over.json()).toMatchObject({ error: "temporarily_unavailable" });
    expect((await from("198.51.100.8")).status).toBe(201);
  });

  it("counts a client page not yet known against the same limit, and a known one for nothing", async () => {
    const hits: string[] = [];
    const counting = createConnector({
      store, origin: ORIGIN, now: () => now,
      fetch: async (input) => {
        const id = String(input);
        hits.push(id);
        return Response.json({ client_id: id, client_name: "Doc", redirect_uris: ["https://doc.example/cb"] });
      },
    });
    const authorize = (id: string, address: string): Promise<Response | null> => counting.handle(new Request(
      `${ORIGIN}/oauth/authorize?${new URLSearchParams({
        response_type: "code", client_id: id, redirect_uri: "https://doc.example/cb", code_challenge: "x".repeat(43), state: "s", resource: MCP,
      })}`,
      { headers: { "cf-connecting-ip": address } },
    ));
    for (let i = 0; i < 60; i += 1) expect((await authorize(`https://doc.example/c${i}.json`, "198.51.100.20"))?.status).toBe(302);
    const over = await authorize("https://doc.example/c60.json", "198.51.100.20");
    expect(over?.status).toBe(400);
    expect(hits).not.toContain("https://doc.example/c60.json");
    // Already known: not counted, so still served from the same address.
    expect((await authorize("https://doc.example/c0.json", "198.51.100.20"))?.status).toBe(302);
  });
});

describe("a client page that is too big", () => {
  const authorizeWith = (fetchPage: typeof fetch): Promise<Response | null> => createConnector({
    store, origin: ORIGIN, now: () => now, fetch: fetchPage,
  }).handle(new Request(`${ORIGIN}/oauth/authorize?${new URLSearchParams({
    response_type: "code", client_id: "https://big.example/client.json", redirect_uri: "https://big.example/cb", code_challenge: "x".repeat(43), state: "s", resource: MCP,
  })}`));

  it("is refused on its content-length without reading the body", async () => {
    let pulled = false;
    const body = new ReadableStream<Uint8Array>({ pull(c) { pulled = true; c.enqueue(new Uint8Array(10)); c.close(); } }, { highWaterMark: 0 });
    const res = await authorizeWith(async () => new Response(body, { headers: { "content-length": "999999" } }));
    expect(res?.status).toBe(400);
    expect(pulled).toBe(false);
  });

  it("is dropped as soon as the stream passes the limit, however much it would have sent", async () => {
    let sent = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(c) { sent += 1_000; c.enqueue(new Uint8Array(1_000).fill(32)); if (sent > 5_000_000) c.close(); },
    });
    const res = await authorizeWith(async () => new Response(body));
    expect(res?.status).toBe(400);
    expect(sent).toBeLessThan(20_000);
  });
});
