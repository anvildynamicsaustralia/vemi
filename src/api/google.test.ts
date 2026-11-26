import { describe, expect, it } from "vitest";
import { GOOGLE_AUTH, GOOGLE_TOKEN, authUrl, challengeFor, exchange, newFlow } from "./google.js";

const CLIENT = "client-123.apps.googleusercontent.com";
const REDIRECT = "https://vemi.example/auth/google/callback";
const NOW = new Date("2026-10-15T12:00:00Z");
const NOW_S = Math.floor(NOW.getTime() / 1000);

function b64url(text: string): string {
  return btoa(text).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function idToken(claims: Record<string, unknown>): string {
  return `${b64url('{"alg":"RS256"}')}.${b64url(JSON.stringify(claims))}.sig`;
}

const good = {
  iss: "https://accounts.google.com",
  aud: CLIENT,
  exp: NOW_S + 600,
  nonce: "the-nonce",
  sub: "1234567890",
  email: "  Andy@Example.COM ",
  email_verified: true,
};

interface Call {
  url: string;
  init: RequestInit | undefined;
}

function stub(body: unknown, status = 200): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fake = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { fetch: fake, calls };
}

function ask(fetcher: typeof fetch) {
  return exchange({
    fetch: fetcher,
    clientId: CLIENT,
    clientSecret: "secret",
    redirectUri: REDIRECT,
    code: "code-1",
    verifier: "verifier-1",
    nonce: "the-nonce",
    now: NOW,
  });
}

function run(claims: Record<string, unknown>) {
  return ask(stub({ id_token: idToken(claims) }).fetch);
}

describe("flow", () => {
  it("makes state, verifier and nonce from 32 random bytes each", () => {
    const a = newFlow();
    const b = newFlow();
    for (const v of [a.state, a.verifier, a.nonce]) expect(v).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(new Set([a.state, a.verifier, a.nonce, b.state, b.verifier, b.nonce]).size).toBe(6);
  });

  it("matches RFC 7636 appendix B", async () => {
    expect(await challengeFor("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe(
      "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    );
  });

  it("builds the authorization url", () => {
    const url = new URL(authUrl({ clientId: CLIENT, redirectUri: REDIRECT, state: "s", challenge: "c", nonce: "n" }));
    expect(url.origin + url.pathname).toBe(GOOGLE_AUTH);
    const p = url.searchParams;
    expect(p.get("client_id")).toBe(CLIENT);
    expect(p.get("redirect_uri")).toBe(REDIRECT);
    expect(p.get("response_type")).toBe("code");
    expect(p.get("scope")).toBe("openid email");
    expect(p.get("state")).toBe("s");
    expect(p.get("code_challenge")).toBe("c");
    expect(p.get("code_challenge_method")).toBe("S256");
    expect(p.get("nonce")).toBe("n");
    expect(p.get("prompt")).toBe("select_account");
    expect(p.has("hd")).toBe(false);
  });
});

describe("exchange", () => {
  it("posts the code and verifier to the token endpoint and returns sub and a normalised email", async () => {
    const s = stub({ id_token: idToken(good) });
    const out = await ask(s.fetch);
    expect(out).toEqual({ ok: true, sub: "1234567890", email: "andy@example.com" });
    expect(s.calls).toHaveLength(1);
    expect(s.calls[0]?.url).toBe(GOOGLE_TOKEN);
    expect(s.calls[0]?.init?.method).toBe("POST");
    const form = new URLSearchParams(String(s.calls[0]?.init?.body));
    expect(Object.fromEntries(form)).toEqual({
      grant_type: "authorization_code",
      code: "code-1",
      code_verifier: "verifier-1",
      client_id: CLIENT,
      client_secret: "secret",
      redirect_uri: REDIRECT,
    });
  });

  it("accepts the bare accounts.google.com issuer", async () => {
    expect((await run({ ...good, iss: "accounts.google.com" })).ok).toBe(true);
  });

  it("refuses a wrong iss", async () => {
    expect((await run({ ...good, iss: "https://evil.example" })).ok).toBe(false);
  });

  it("refuses a wrong aud", async () => {
    expect((await run({ ...good, aud: "someone-else" })).ok).toBe(false);
  });

  it("refuses an expired token", async () => {
    expect((await run({ ...good, exp: NOW_S - 1 })).ok).toBe(false);
    expect((await run({ ...good, exp: NOW_S })).ok).toBe(false);
  });

  it("refuses a token with no exp", async () => {
    const { exp: _exp, ...rest } = good;
    expect((await run(rest)).ok).toBe(false);
  });

  it("refuses a nonce that does not match", async () => {
    expect((await run({ ...good, nonce: "other" })).ok).toBe(false);
  });

  it("refuses an email that is not verified", async () => {
    expect((await run({ ...good, email_verified: false })).ok).toBe(false);
    expect((await run({ ...good, email_verified: "true" })).ok).toBe(false);
    const { email_verified: _v, ...rest } = good;
    expect((await run(rest)).ok).toBe(false);
  });

  it("refuses a token with no sub", async () => {
    const { sub: _sub, ...rest } = good;
    expect((await run(rest)).ok).toBe(false);
    expect((await run({ ...good, sub: "" })).ok).toBe(false);
  });

  it("refuses a token with no email", async () => {
    const { email: _email, ...rest } = good;
    expect((await run(rest)).ok).toBe(false);
  });

  it("names the failed claim in why", async () => {
    const out = await run({ ...good, aud: "x" });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.why).toMatch(/aud/);
  });

  it("refuses when Google answers with an error status", async () => {
    expect((await ask(stub({ error: "invalid_grant" }, 400).fetch)).ok).toBe(false);
  });

  it("refuses a reply with no id_token or a malformed one", async () => {
    for (const body of [{}, { id_token: "nope" }, { id_token: "a.!!!.c" }]) {
      expect((await ask(stub(body).fetch)).ok).toBe(false);
    }
  });

  it("refuses when the network call throws", async () => {
    const down = (async () => {
      throw new Error("down");
    }) as typeof fetch;
    expect((await ask(down)).ok).toBe(false);
  });
});
