/**
 * Google sign-in as a pure module: PKCE, the authorization url, and the code exchange.
 * With `accountIdentity.ts`, the only file that names Google's endpoints. It takes `fetch`
 * and the clock as arguments, so a test never reaches the network.
 *
 * - **Authorization code flow with PKCE (S256), `state` and `nonce`.** `newFlow` makes all
 *   three, 32 random bytes each. The caller keeps them in a signed cookie.
 * - **The id_token signature is not verified.** The token comes straight from Google's token
 *   endpoint over TLS, in exchange for the code and the client secret. Google's OpenID
 *   Connect page says a token received that way can be trusted to come from Google
 *   (https://developers.google.com/identity/openid-connect/openid-connect). So there is no
 *   JWKS fetch or cache to keep up.
 * - **A Google identity is its `sub`.** The email is returned for matching, never as the key.
 */

export const GOOGLE_AUTH = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_TOKEN = "https://oauth2.googleapis.com/token";

const ISSUERS = new Set(["https://accounts.google.com", "accounts.google.com"]);

export interface Flow {
  state: string;
  verifier: string;
  nonce: string;
}

export type Exchanged = { ok: true; sub: string; email: string } | { ok: false; why: string };

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function randomToken(): string {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
}

export function newFlow(): Flow {
  return { state: randomToken(), verifier: randomToken(), nonce: randomToken() };
}

export async function challengeFor(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return toBase64Url(new Uint8Array(digest));
}

export function authUrl(args: {
  clientId: string;
  redirectUri: string;
  state: string;
  challenge: string;
  nonce: string;
}): string {
  const url = new URL(GOOGLE_AUTH);
  url.searchParams.set("client_id", args.clientId);
  url.searchParams.set("redirect_uri", args.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "openid email");
  url.searchParams.set("state", args.state);
  url.searchParams.set("code_challenge", args.challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("nonce", args.nonce);
  url.searchParams.set("prompt", "select_account");
  return url.toString();
}

function payloadOf(idToken: string): Record<string, unknown> | null {
  const part = idToken.split(".")[1];
  if (!part) return null;
  try {
    const padded = part.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat((4 - (part.length % 4)) % 4);
    const bytes = Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export async function exchange(args: {
  fetch: typeof fetch;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  code: string;
  verifier: string;
  nonce: string;
  now: Date;
}): Promise<Exchanged> {
  let reply: Response;
  try {
    reply = await args.fetch(GOOGLE_TOKEN, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: args.code,
        code_verifier: args.verifier,
        client_id: args.clientId,
        client_secret: args.clientSecret,
        redirect_uri: args.redirectUri,
      }).toString(),
    });
  } catch {
    return { ok: false, why: "Google could not be reached" };
  }
  if (!reply.ok) return { ok: false, why: "Google refused the code" };

  let body: unknown;
  try {
    body = await reply.json();
  } catch {
    return { ok: false, why: "Google sent an unreadable reply" };
  }
  const idToken = (body as { id_token?: unknown } | null)?.id_token;
  if (typeof idToken !== "string") return { ok: false, why: "Google sent no id_token" };
  const claims = payloadOf(idToken);
  if (!claims) return { ok: false, why: "the id_token is malformed" };

  if (typeof claims.iss !== "string" || !ISSUERS.has(claims.iss)) return { ok: false, why: "iss is not Google" };
  if (claims.aud !== args.clientId) return { ok: false, why: "aud is not this client" };
  if (typeof claims.exp !== "number" || claims.exp * 1000 <= args.now.getTime()) {
    return { ok: false, why: "exp has passed" };
  }
  if (claims.nonce !== args.nonce) return { ok: false, why: "nonce does not match" };
  if (claims.email_verified !== true) return { ok: false, why: "email_verified is not true" };
  if (typeof claims.sub !== "string" || claims.sub === "") return { ok: false, why: "sub is missing" };
  if (typeof claims.email !== "string" || claims.email.trim() === "") return { ok: false, why: "email is missing" };

  return { ok: true, sub: claims.sub, email: claims.email.trim().toLowerCase() };
}
