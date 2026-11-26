import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { accountIdentity, networkOf } from "./accountIdentity.js";
import { createApp, type App } from "./app.js";
import { GOOGLE_TOKEN } from "./google.js";
import { hashPassword, needsRehash, PBKDF2_ITERATIONS } from "./password.js";
import { openStore } from "./store.js";
import { testDb, type TestDb } from "./testing/d1.js";

/**
 * Every route and every refusal of the account identity, through `createApp` and a real D1.
 * No mail exists: an invite link is handed back to the owner. Google goes to a stub `fetch`; nothing leaves the process.
 */

const ORIGIN = "https://vemi.example.workers.dev";
const PASSWORD = "correct horse battery";
const CLIENT = { clientId: "client-id", clientSecret: "client-secret" };

let t: TestDb;
beforeAll(async () => {
  t = await testDb();
});
afterAll(() => t.dispose());

const unique = (stem: string): string => `${stem}-${crypto.randomUUID()}@example.com`;

interface GoogleClaims {
  sub: string;
  email: string;
  email_verified: boolean;
}

/** Google's token endpoint: hands back an id_token for whatever `claims` say, with the nonce of the last flow started. */
function googleStub(now: () => Date) {
  const stub = {
    claims: { sub: `sub-${crypto.randomUUID()}`, email: unique("someone"), email_verified: true } as GoogleClaims,
    nonce: "",
    calls: [] as string[],
    bodies: [] as URLSearchParams[],
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      stub.calls.push(String(input));
      if (String(input) !== GOOGLE_TOKEN) throw new Error(`unexpected request to ${String(input)}`);
      stub.bodies.push(new URLSearchParams(String(init?.body)));
      const payload = {
        iss: "https://accounts.google.com",
        aud: CLIENT.clientId,
        exp: Math.floor(now().getTime() / 1000) + 3600,
        nonce: stub.nonce,
        ...stub.claims,
      };
      const part = (value: unknown): string => btoa(JSON.stringify(value)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
      return Response.json({ id_token: `${part({ alg: "RS256" })}.${part(payload)}.signature` });
    }) as typeof fetch,
  };
  return stub;
}

interface World {
  readonly owner: string;
  readonly operator: string;
  readonly google: ReturnType<typeof googleStub>;
  readonly store: ReturnType<typeof openStore>;
  readonly app: App;
  readonly identity: ReturnType<typeof accountIdentity>;
  device(ip?: string): Device;
  advance(ms: number): void;
}

interface Device {
  call(method: string, path: string, body?: unknown, headers?: Record<string, string>): Promise<Response>;
  cookie(name: string): string | undefined;
  setCookie(name: string, value: string): void;
}

interface WorldOptions {
  google?: boolean;
  /** False is a copy with no `OPERATOR_EMAIL`: the first sign-up owns it. */
  operatorSet?: boolean;
  sessionSecret?: string | (() => Promise<string>);
}

function world(options: WorldOptions = {}): World {
  const owner = `owner-${crypto.randomUUID()}`;
  const operator = unique("operator");
  let now = new Date("2026-09-14T02:00:00Z");
  const clock = () => now;
  const store = openStore({ DB: t.db }, clock);
  const google = googleStub(clock);
  const identity = accountIdentity({
    store, now: clock, origin: ORIGIN, owner, operatorEmail: options.operatorSet === false ? "" : operator,
    sessionSecret: options.sessionSecret ?? "session-secret",
    google: options.google === false ? null : CLIENT,
    fetch: google.fetch,
  });
  const app = createApp({
    store, identity, now: clock, origin: ORIGIN, timeZone: "Australia/Sydney",
    live: { publish: async () => {}, connect: async () => new Response("connected") },
  });
  let devices = 0;
  return {
    owner, operator, google, store, app, identity,
    advance: (ms) => { now = new Date(now.getTime() + ms); },
    device(ip = `10.0.${++devices}.${Math.floor(Math.random() * 250)}`) {
      const jar = new Map<string, string>();
      return {
        cookie: (name) => jar.get(name),
        setCookie: (name, value) => { jar.set(name, value); },
        async call(method, path, body, headers = {}) {
          const behind: Promise<unknown>[] = [];
          const response = await app(
            new Request(`${ORIGIN}${path}`, {
              method,
              headers: {
                origin: ORIGIN,
                "cf-connecting-ip": ip,
                ...(jar.size > 0 ? { cookie: [...jar].map(([k, v]) => `${k}=${v}`).join("; ") } : {}),
                ...(body === undefined ? {} : { "content-type": "application/json" }),
                ...headers,
              },
              ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            }),
            (work) => { behind.push(work); },
          );
          // What the Worker would finish after answering, finished before the test looks.
          await Promise.all(behind);
          for (const line of response.headers.getSetCookie()) {
            const [pair = ""] = line.split(";");
            const at = pair.indexOf("=");
            const name = pair.slice(0, at);
            const value = pair.slice(at + 1);
            if (/Max-Age=0/i.test(line) || value === "") jar.delete(name);
            else jar.set(name, value);
          }
          return response;
        },
      };
    },
  };
}

const body = async <T = Record<string, unknown>>(response: Response): Promise<T> => response.json() as Promise<T>;

/** An account made straight in the store: confirmed, with a password unless `password` is null. */
async function seed(w: World, over: { email?: string; password?: string | null; googleSub?: string | null; confirmed?: boolean; id?: string } = {}) {
  const email = over.email ?? unique("person");
  const id = over.id ?? crypto.randomUUID();
  const password = over.password === undefined ? PASSWORD : over.password;
  const made = await w.store.createAccount({
    id, email, passwordHash: password === null ? null : await hashPassword(password),
    googleSub: over.googleSub ?? null, confirmed: over.confirmed ?? true,
  });
  expect(made).toBe(true);
  return { id, email };
}

async function signedIn(w: World, email: string, password = PASSWORD, ip?: string): Promise<Device> {
  const d = w.device(ip);
  const response = await d.call("POST", "/auth/sign-in", { email, password });
  expect(response.status).toBe(200);
  return d;
}

/** The operator claims OWNER with a password, the way a fresh copy is first opened. */
async function claim(w: World): Promise<Device> {
  const d = w.device();
  const response = await d.call("POST", "/auth/claim", { email: w.operator, password: PASSWORD });
  expect(response.status).toBe(200);
  return d;
}

/** The owner invites an address and gets the link back; the token is its fragment. */
async function invite(owner: Device, email: string): Promise<string> {
  const response = await owner.call("POST", "/auth/invite", { email });
  expect(response.status).toBe(200);
  const { link } = await body<{ ok: true; link: string }>(response);
  return link.slice(link.indexOf("#") + 1);
}

async function sha256(text: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
  return Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** A reset link as one is stored. Nothing issues one now; People will. Returns its token. */
async function plantReset(w: World, id: string, email: string): Promise<string> {
  const token = `planted-${crypto.randomUUID()}`;
  await w.store.putEmailToken({ id: await sha256(token), owner: id, purpose: "reset", email, expiresAt: "2026-09-14T03:00:00.000Z" });
  return token;
}

/** Starts a Google flow and answers the state the callback must return. */
async function startGoogle(w: World, d: Device, request: Record<string, unknown>): Promise<string> {
  const response = await d.call("POST", "/auth/google/start", request);
  expect(response.status).toBe(200);
  const url = new URL((await body<{ url: string }>(response)).url);
  w.google.nonce = url.searchParams.get("nonce") ?? "";
  return url.searchParams.get("state") ?? "";
}

const callback = (d: Device, state: string, extra = "code=a-code") => d.call("GET", `/auth/google/callback?${extra}&state=${encodeURIComponent(state)}`);

describe("who is signed in", () => {
  it("says what it is and what is unset", () => {
    const w = world({ google: false });
    expect(w.identity.describe).not.toContain("unset: mail");
    expect(w.identity.describe).toContain("Google");
    const bare = accountIdentity({
      store: w.store, now: () => new Date(), origin: ORIGIN, owner: "", operatorEmail: "", sessionSecret: "",
      google: null, fetch: w.google.fetch,
    });
    expect(bare.describe).toContain("OWNER");
    expect(bare.describe).not.toContain("SESSION_SECRET");
    expect(bare.describe).not.toContain("OPERATOR_EMAIL");
  });

  it("signs a person in when the secret comes from a function, and does not fail closed for it", async () => {
    const w = world({ sessionSecret: async () => "a secret from a function" });
    const d = w.device();
    expect((await d.call("POST", "/auth/claim", { email: w.operator, password: PASSWORD })).status).toBe(200);
    expect((await d.call("GET", "/api/overview")).status).toBe(200);
  });

  it("refuses with the reason: sign in first, signed out everywhere, no longer exists", async () => {
    const w = world();
    const { email, id } = await seed(w);
    const d = await signedIn(w, email);
    const carrying = new Request(`${ORIGIN}/api/overview`, { headers: { cookie: `__Host-vemi=${d.cookie("__Host-vemi")}` } });

    expect(await w.identity.resolve(new Request(`${ORIGIN}/api/overview`))).toEqual({ refused: "Sign in first." });
    expect(await w.identity.resolve(new Request(`${ORIGIN}/api/overview`, { headers: { cookie: "__Host-vemi=forged.value" } }))).toEqual({ refused: "Sign in first." });
    expect(await w.identity.resolve(carrying)).toEqual({ owner: id });

    await w.store.endSessions(id);
    expect(await w.identity.resolve(carrying)).toEqual({ refused: "Signed out everywhere. Sign in again." });

    await t.db.prepare(`DELETE FROM account WHERE id = ?`).bind(id).run();
    expect(await w.identity.resolve(carrying)).toEqual({ refused: "This account no longer exists." });
  });

  it("reads one session row per resolve", async () => {
    const w = world();
    const { email } = await seed(w);
    const d = await signedIn(w, email);
    t.resetCount();
    await w.identity.resolve(new Request(`${ORIGIN}/api/overview`, { headers: { cookie: `__Host-vemi=${d.cookie("__Host-vemi")}` } }));
    expect(t.queries()).toBe(1);
  });

  it("hands a read's answer on only when the session held, its check in the read's round trip", async () => {
    const w = world();
    const { email, id } = await seed(w);
    const d = await signedIn(w, email);
    const carrying = new Request(`${ORIGIN}/api/tree`, { headers: { cookie: `__Host-vemi=${d.cookie("__Host-vemi")}` } });
    const read = (owner: string, store: typeof w.store) => store.tree(owner);

    t.resetCount();
    expect(await w.identity.resolveRead(carrying, read)).toEqual({ owner: id, read: { ventures: [] } });
    expect(t.queries()).toBe(1);

    let ran = 0;
    expect(await w.identity.resolveRead(new Request(`${ORIGIN}/api/tree`), async () => ++ran)).toEqual({ refused: "Sign in first." });
    expect(ran).toBe(0);

    await w.store.endSessions(id);
    expect(await w.identity.resolveRead(carrying, read)).toEqual({ refused: "Signed out everywhere. Sign in again." });
    await t.db.prepare(`DELETE FROM account WHERE id = ?`).bind(id).run();
    expect(await w.identity.resolveRead(carrying, read)).toEqual({ refused: "This account no longer exists." });
  });

  it("answers /auth/me for a signed-out and a signed-in browser", async () => {
    const w = world();
    const { email } = await seed(w);
    const out = await w.device().call("GET", "/auth/me");
    expect(await body(out)).toEqual({ signedIn: false, googleReady: true, claimable: true });

    const d = await signedIn(w, email);
    expect(await body(await d.call("GET", "/auth/me"))).toEqual({
      signedIn: true, id: expect.any(String), email, operator: false, password: true, google: false, firstName: null, twoStep: false, deleteOn: null, googleReady: true,
    });
  });

  it("keeps the origin and JSON checks on every POST", async () => {
    const w = world();
    const d = w.device();
    expect((await d.call("POST", "/auth/sign-in", {}, { origin: "https://elsewhere.example" })).status).toBe(403);
    expect((await d.call("POST", "/auth/sign-in", {}, { "content-type": "text/plain" })).status).toBe(415);
    // The type itself, not a mention of it in a parameter.
    expect((await d.call("POST", "/auth/sign-in", {}, { "content-type": "text/plain; x=application/json" })).status).toBe(415);
    expect((await d.call("PUT", "/auth/sign-in", {})).status).toBe(405);
    expect((await d.call("POST", "/auth/nothing", {})).status).toBe(404);
  });
});

describe("sign in", () => {
  it("signs in with the right password and reaches /api", async () => {
    const w = world();
    const { email } = await seed(w);
    const d = w.device();
    expect((await d.call("GET", "/api/overview")).status).toBe(401);
    const response = await d.call("POST", "/auth/sign-in", { email: `  ${email.toUpperCase()} `, password: PASSWORD });
    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toMatch(/^__Host-vemi=.*HttpOnly; Secure; SameSite=Strict/);
    expect((await d.call("GET", "/api/overview")).status).toBe(200);
  });

  it("answers every failure with one sentence", async () => {
    const w = world();
    const known = await seed(w);
    const googleOnly = await seed(w, { password: null, googleSub: `sub-${crypto.randomUUID()}` });
    const unconfirmed = await seed(w, { confirmed: false });
    const d = w.device();
    const replies = [];
    for (const attempt of [
      { email: known.email, password: "the wrong password" },
      { email: unique("nobody"), password: PASSWORD },
      { email: googleOnly.email, password: PASSWORD },
      { email: unconfirmed.email, password: PASSWORD },
      { email: 7, password: null },
    ]) {
      const response = await d.call("POST", "/auth/sign-in", attempt);
      expect(response.status).toBe(401);
      expect(response.headers.get("set-cookie")).toBeNull();
      replies.push(await body(response));
    }
    for (const reply of replies) expect(reply).toEqual({ error: "That email and password don't match." });
  });

  it("throttles at 5 failures per email, and a success clears them", async () => {
    const w = world();
    const { email } = await seed(w);
    const d = w.device();
    for (let i = 0; i < 4; i++) expect((await d.call("POST", "/auth/sign-in", { email, password: "wrong password" })).status).toBe(401);
    expect((await d.call("POST", "/auth/sign-in", { email, password: PASSWORD })).status).toBe(200);
    // Cleared: four more failures are allowed, and so is the success after them.
    for (let i = 0; i < 4; i++) expect((await d.call("POST", "/auth/sign-in", { email, password: "wrong password" })).status).toBe(401);
    expect((await d.call("POST", "/auth/sign-in", { email, password: PASSWORD })).status).toBe(200);

    for (let i = 0; i < 5; i++) expect((await d.call("POST", "/auth/sign-in", { email, password: "wrong password" })).status).toBe(401);
    const blocked = await d.call("POST", "/auth/sign-in", { email, password: PASSWORD });
    expect(blocked.status).toBe(429);
    expect(await body(blocked)).toEqual({ error: "Too many tries. Wait 15 minutes and try again." });
    expect(blocked.headers.get("set-cookie")).toBeNull();
    // Another address from the same place is not blocked by this email's count.
    const other = await seed(w);
    expect((await d.call("POST", "/auth/sign-in", { email: other.email, password: PASSWORD })).status).toBe(200);
    // And the window passes.
    w.advance(16 * 60 * 1000);
    expect((await d.call("POST", "/auth/sign-in", { email, password: PASSWORD })).status).toBe(200);
  });

  it("throttles at 30 failures per IP, across addresses", async () => {
    const w = world();
    const { email } = await seed(w);
    const d = w.device("203.0.113.9");
    for (let i = 0; i < 30; i++) {
      expect((await d.call("POST", "/auth/sign-in", { email: unique("guess"), password: "wrong password" })).status).toBe(401);
    }
    expect((await d.call("POST", "/auth/sign-in", { email, password: PASSWORD })).status).toBe(429);
    expect((await w.device("203.0.113.10").call("POST", "/auth/sign-in", { email, password: PASSWORD })).status).toBe(200);
  });

  it("holds a burst sent all at once to five password checks", async () => {
    const w = world();
    const { email } = await seed(w);
    const d = w.device();
    const answers = await Promise.all(Array.from({ length: 20 }, () =>
      d.call("POST", "/auth/sign-in", { email, password: "wrong password" })));
    const statuses = answers.map((r) => r.status);
    expect(statuses.filter((s) => s === 401)).toHaveLength(5);
    expect(statuses.filter((s) => s === 429)).toHaveLength(15);
  });

  it("counts an IPv6 address by its /64", async () => {
    expect(networkOf("2001:db8:85a3:12:8a2e:370:7334:1")).toBe("2001:db8:85a3:12::/64");
    expect(networkOf("2001:DB8:85A3:0012::9")).toBe("2001:db8:85a3:12::/64");
    expect(networkOf("2001:db8::1")).toBe("2001:db8:0:0::/64");
    expect(networkOf("::1")).toBe("0:0:0:0::/64");
    expect(networkOf("203.0.113.9")).toBe("203.0.113.9");
    expect(networkOf("::ffff:203.0.113.5")).toBe("203.0.113.5");
    expect(networkOf("::FFFF:198.51.100.7")).toBe("198.51.100.7");
    expect(networkOf("64:ff9b::192.0.2.33")).toBe("192.0.2.33");

    const w = world();
    const { email } = await seed(w);
    for (let i = 0; i < 30; i++) {
      const roaming = w.device(`2001:db8:85a3:12:${i.toString(16)}::1`);
      expect((await roaming.call("POST", "/auth/sign-in", { email: unique("guess"), password: "wrong password" })).status).toBe(401);
    }
    expect((await w.device("2001:db8:85a3:12:ffff::2").call("POST", "/auth/sign-in", { email, password: PASSWORD })).status).toBe(429);
    expect((await w.device("2001:db8:85a3:13::2").call("POST", "/auth/sign-in", { email, password: PASSWORD })).status).toBe(200);
  });

  it("gives a good sign-in's place back to the network", async () => {
    const w = world();
    const { email } = await seed(w);
    const d = w.device("203.0.113.44");
    for (let i = 0; i < 31; i++) expect((await d.call("POST", "/auth/sign-in", { email, password: PASSWORD })).status).toBe(200);
  });

  it("keeps a session in use alive past thirty days, and lets an idle one run out", async () => {
    const w = world();
    const { email } = await seed(w);
    const daily = await signedIn(w, email);
    const idle = await signedIn(w, email);
    const DAY = 24 * 60 * 60 * 1000;

    w.advance(5 * DAY);
    const early = await daily.call("GET", "/api/overview");
    expect(early.status).toBe(200);
    expect(early.headers.get("set-cookie")).toBeNull();

    w.advance(15 * DAY);
    const renewed = await daily.call("GET", "/api/overview");
    expect(renewed.status).toBe(200);
    expect(renewed.headers.get("set-cookie")).toMatch(/^__Host-vemi=.*Max-Age=2592000; HttpOnly; Secure; SameSite=Strict$/);

    // Forty days after signing in: the one in use holds, the idle one does not.
    w.advance(20 * DAY);
    expect((await daily.call("GET", "/api/overview")).status).toBe(200);
    expect((await idle.call("GET", "/api/overview")).status).toBe(401);

    // A renewed session is still the same generation, so signing out everywhere ends it.
    const other = await signedIn(w, email);
    expect((await other.call("POST", "/auth/sign-out-everywhere", {})).status).toBe(200);
    expect((await daily.call("GET", "/api/overview")).status).toBe(401);
  });

  it("keeps a device signed out when a renewing read answers after the sign-out", async () => {
    const w = world();
    const { email } = await seed(w);
    const d = await signedIn(w, email);
    w.advance(16 * 24 * 60 * 60 * 1000);
    // Sent before the sign-out, so it carries the session and nothing else.
    const sent = `__Host-vemi=${d.cookie("__Host-vemi") ?? ""}`;
    expect((await d.call("POST", "/auth/sign-out", {})).status).toBe(200);
    expect(d.cookie("__Host-vemi")).toBeUndefined();

    const late = await d.call("GET", "/api/overview", undefined, { cookie: sent });
    expect(late.status).toBe(200);
    expect(late.headers.get("set-cookie")).toMatch(/^__Host-vemi=/);
    expect(d.cookie("__Host-vemi")).toBeDefined();

    expect((await d.call("GET", "/api/overview")).status).toBe(401);
    expect(await body(await d.call("GET", "/auth/me"))).toMatchObject({ signedIn: false });

    // Signing in again is a session the person asked for: the mark goes with it.
    expect((await d.call("POST", "/auth/sign-in", { email, password: PASSWORD })).status).toBe(200);
    expect(d.cookie("__Host-vemi-out")).toBeUndefined();
    expect((await d.call("GET", "/api/overview")).status).toBe(200);
  });

  it("keeps no raw address or IP in the throttle", async () => {
    const w = world();
    const email = unique("recorded");
    await w.device("198.51.100.77").call("POST", "/auth/sign-in", { email, password: "wrong password" });
    const rows = await t.db.prepare(`SELECT key FROM throttle`).all<{ key: string }>();
    for (const row of rows.results) {
      expect(row.key).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it("rehashes a password stored at another iteration count", async () => {
    const w = world();
    const email = unique("old");
    const id = crypto.randomUUID();
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(PASSWORD), "PBKDF2", false, ["deriveBits"]);
    const bits = new Uint8Array(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: 50000 }, key, 256));
    const b64 = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
    const old = `pbkdf2-sha256$50000$${b64(salt)}$${b64(bits)}`;
    expect(old).not.toContain(`$${PBKDF2_ITERATIONS}$`);
    expect(await w.store.createAccount({ id, email, passwordHash: old, googleSub: null, confirmed: true })).toBe(true);

    const d = w.device();
    expect((await d.call("POST", "/auth/sign-in", { email, password: PASSWORD })).status).toBe(200);
    const after = await w.store.account(id);
    expect(after?.passwordHash).not.toBe(old);
    expect(needsRehash(after?.passwordHash ?? "")).toBe(false);
    // The session issued with the rehash still holds.
    expect((await d.call("GET", "/api/overview")).status).toBe(200);
    expect((await d.call("POST", "/auth/sign-in", { email, password: PASSWORD })).status).toBe(200);
  });

  it("signs out one device, and out of every device", async () => {
    const w = world();
    const { email } = await seed(w);
    const a = await signedIn(w, email);
    const b = await signedIn(w, email);

    expect((await a.call("POST", "/auth/sign-out", {})).status).toBe(200);
    expect(a.cookie("__Host-vemi")).toBeUndefined();
    expect((await a.call("GET", "/api/overview")).status).toBe(401);
    expect((await b.call("GET", "/api/overview")).status).toBe(200);

    const c = await signedIn(w, email);
    expect((await c.call("POST", "/auth/sign-out-everywhere", {})).status).toBe(200);
    // This device is given a fresh cookie; the others are refused at their next request.
    expect((await c.call("GET", "/api/overview")).status).toBe(200);
    expect((await b.call("GET", "/api/overview")).status).toBe(401);
    expect((await w.device().call("POST", "/auth/sign-out-everywhere", {})).status).toBe(401);
  });
});

describe("the password", () => {
  it("needs the current one, throttles guessing it, and ends the other devices", async () => {
    const w = world();
    const { email } = await seed(w);
    const a = await signedIn(w, email);
    const b = await signedIn(w, email);
    const next = "a brand new passphrase";

    expect((await a.call("POST", "/auth/password", { next })).status).toBe(403);
    expect((await a.call("POST", "/auth/password", { current: "not it at all", next })).status).toBe(403);
    expect((await a.call("POST", "/auth/password", { current: PASSWORD, next: "short" })).status).toBe(400);
    expect((await w.device().call("POST", "/auth/password", { current: PASSWORD, next })).status).toBe(401);

    expect((await a.call("POST", "/auth/password", { current: PASSWORD, next })).status).toBe(200);
    expect((await a.call("GET", "/api/overview")).status).toBe(200);
    expect((await b.call("GET", "/api/overview")).status).toBe(401);
    expect((await w.device().call("POST", "/auth/sign-in", { email, password: next })).status).toBe(200);
    expect((await w.device().call("POST", "/auth/sign-in", { email, password: PASSWORD })).status).toBe(401);
  });

  it("stops guesses at the current password after five", async () => {
    const w = world();
    const { email } = await seed(w);
    const a = await signedIn(w, email);
    for (let i = 0; i < 5; i++) expect((await a.call("POST", "/auth/password", { current: "not it at all", next: "a brand new passphrase" })).status).toBe(403);
    const blocked = await a.call("POST", "/auth/password", { current: PASSWORD, next: "a brand new passphrase" });
    expect(blocked.status).toBe(429);
    // Signed in already, so a reset is no way past it.
    expect(await body(blocked)).toEqual({ error: "Too many tries. Wait 15 minutes and try again." });
  });

  it("lets a Google-only account set one without a current password", async () => {
    const w = world();
    const { email } = await seed(w, { password: null, googleSub: `sub-${crypto.randomUUID()}` });
    w.google.claims = { sub: (await w.store.accountsForGoogle("", email))[0]?.googleSub ?? "", email, email_verified: true };
    const d = w.device();
    const state = await startGoogle(w, d, { intent: "sign-in" });
    expect((await callback(d, state)).status).toBe(302);
    expect((await d.call("POST", "/auth/password", { next: "a brand new passphrase" })).status).toBe(200);
    expect(await body(await d.call("GET", "/auth/me"))).toMatchObject({ password: true, google: true });
    expect((await w.device().call("POST", "/auth/sign-in", { email, password: "a brand new passphrase" })).status).toBe(200);
  });
});

describe("reset", () => {
  it("sets the password from a link, confirms the address, and spends the token", async () => {
    const w = world();
    const { email, id } = await seed(w);
    const token = await plantReset(w, id, email);
    const d = w.device();

    expect((await d.call("POST", "/auth/reset", { token, password: "short" })).status).toBe(400);
    const done = await d.call("POST", "/auth/reset", { token, password: "a brand new passphrase" });
    expect(done.status).toBe(200);
    expect((await d.call("GET", "/api/overview")).status).toBe(200);
    expect((await w.store.account(id))?.confirmed).toBe(true);

    expect((await w.device().call("POST", "/auth/reset", { token, password: "another new passphrase" })).status).toBe(400);
    expect((await w.device().call("POST", "/auth/sign-in", { email, password: "a brand new passphrase" })).status).toBe(200);
  });

  it("ends another device's session", async () => {
    const w = world();
    const { email, id } = await seed(w);
    const other = await signedIn(w, email);
    expect((await other.call("GET", "/api/overview")).status).toBe(200);

    const token = await plantReset(w, id, email);
    const here = w.device();
    expect((await here.call("POST", "/auth/reset", { token, password: "a brand new passphrase" })).status).toBe(200);

    expect((await other.call("GET", "/api/overview")).status).toBe(401);
    expect((await here.call("GET", "/api/overview")).status).toBe(200);
  });

  it("refuses an expired token, a spent one, a made-up one and one of another purpose", async () => {
    const w = world();
    const { email, id } = await seed(w);
    const d = w.device();
    const token = await plantReset(w, id, email);

    // The wrong purpose does not spend it.
    expect((await d.call("POST", "/auth/invite/accept", { token, password: PASSWORD })).status).toBe(400);
    expect((await d.call("POST", "/auth/reset", { token: "made-up", password: PASSWORD })).status).toBe(400);
    expect((await d.call("POST", "/auth/reset", { token: 5, password: PASSWORD })).status).toBe(400);

    w.advance(61 * 60 * 1000);
    const late = await d.call("POST", "/auth/reset", { token, password: PASSWORD });
    expect(late.status).toBe(400);
    expect(await body(late)).toEqual({ error: "That link has expired or was already used. Ask for a new one.", code: "link" });
    // Expired is spent too.
    w.advance(-61 * 60 * 1000);
    expect((await d.call("POST", "/auth/reset", { token, password: PASSWORD })).status).toBe(400);
  });

  it("has no forgot or confirm route, and says nothing about a reset past the sign-in limit", async () => {
    const w = world();
    const { email } = await seed(w);
    const d = w.device();
    expect((await d.call("POST", "/auth/forgot", { email })).status).toBe(404);
    expect((await d.call("POST", "/auth/confirm", { token: "x", password: PASSWORD })).status).toBe(404);
    for (let i = 0; i < 5; i++) await d.call("POST", "/auth/sign-in", { email, password: "wrong password" });
    expect(await body(await d.call("POST", "/auth/sign-in", { email, password: PASSWORD })))
      .toEqual({ error: "Too many tries. Wait 15 minutes and try again." });
  });
});

describe("looking at a link", () => {
  it("answers the address a live reset link is for, and does not spend it", async () => {
    const w = world();
    const { email, id } = await seed(w);
    const d = w.device();
    const token = await plantReset(w, id, email);

    for (let i = 0; i < 2; i++) {
      const looked = await d.call("POST", "/auth/link", { token, purpose: "reset" });
      expect(looked.status).toBe(200);
      expect(await body(looked)).toEqual({ email });
    }
    expect((await d.call("POST", "/auth/reset", { token, password: PASSWORD })).status).toBe(200);
    // Spent now, and the page can tell before anyone types.
    expect(await body(await d.call("POST", "/auth/link", { token, purpose: "reset" })))
      .toEqual({ error: "That link has expired or was already used. Ask for a new one.", code: "link" });
  });

  it("answers an invite's address, and refuses one of another purpose, a made-up one and an expired one", async () => {
    const w = world();
    const op = await claim(w);
    const friend = unique("friend");
    const token = await invite(op, friend);
    const d = w.device();

    expect(await body(await d.call("POST", "/auth/link", { token, purpose: "invite" }))).toEqual({ email: friend });
    expect((await d.call("POST", "/auth/link", { token, purpose: "reset" })).status).toBe(400);
    expect((await d.call("POST", "/auth/link", { token, purpose: "confirm" })).status).toBe(400);
    expect((await d.call("POST", "/auth/link", { token: "made-up", purpose: "invite" })).status).toBe(400);
    expect((await d.call("POST", "/auth/link", { token: 5, purpose: "invite" })).status).toBe(400);
    expect((await d.call("POST", "/auth/link", { token, purpose: "nonsense" })).status).toBe(400);
    w.advance(8 * 24 * 60 * 60 * 1000);
    expect(await body(await d.call("POST", "/auth/link", { token, purpose: "invite" })))
      .toMatchObject({ code: "link" });
  });
});

describe("the operator", () => {
  it("says a fresh copy is claimable until the owner account exists", async () => {
    const w = world();
    expect(await body(await w.device().call("GET", "/auth/me"))).toMatchObject({ signedIn: false, claimable: true });
    await claim(w);
    expect(await body(await w.device().call("GET", "/auth/me"))).toMatchObject({ signedIn: false, claimable: false });
  });

  it("claims OWNER with a password, once", async () => {
    const w = world();
    const d = w.device();

    expect((await d.call("POST", "/auth/claim", { email: w.operator, password: "short" })).status).toBe(400);
    expect((await d.call("POST", "/auth/claim", { email: w.operator })).status).toBe(400);
    expect((await d.call("POST", "/auth/claim", { password: PASSWORD })).status).toBe(400);
    // No address runs past 254 characters, so none is stored that long.
    expect((await d.call("POST", "/auth/claim", { email: `${"a".repeat(250)}@example.com`, password: PASSWORD })).status).toBe(400);
    const claimed = await d.call("POST", "/auth/claim", { email: w.operator, password: PASSWORD });
    expect(claimed.status).toBe(200);
    expect(await w.store.account(w.owner)).toMatchObject({ id: w.owner, email: w.operator, confirmed: true, hasPassword: true });
    expect(await body(await d.call("GET", "/auth/me"))).toMatchObject({ signedIn: true, operator: true, email: w.operator });
    expect((await d.call("GET", "/api/overview")).status).toBe(200);

    const again = await w.device().call("POST", "/auth/claim", { email: w.operator, password: "another passphrase" });
    expect(again.status).toBe(409);
    expect((await w.device().call("POST", "/auth/sign-in", { email: w.operator, password: "another passphrase" })).status).toBe(401);
    expect((await w.device().call("POST", "/auth/sign-in", { email: w.operator, password: PASSWORD })).status).toBe(200);
  });

  it("refuses a claim from a cross-origin page", async () => {
    const w = world();
    expect((await w.device().call("POST", "/auth/claim", { email: w.operator, password: PASSWORD }, { origin: "https://evil.example" })).status).toBe(403);
    expect(await w.store.account(w.owner)).toBeNull();
  });

  it("with OPERATOR_EMAIL set, only that address claims", async () => {
    const w = world();
    expect((await w.device().call("POST", "/auth/claim", { email: unique("stranger"), password: PASSWORD })).status).toBe(403);
    expect(await w.store.account(w.owner)).toBeNull();
    expect(await body(await w.device().call("GET", "/auth/me"))).toMatchObject({ claimable: true });
    expect((await w.device().call("POST", "/auth/claim", { email: w.operator.toUpperCase(), password: PASSWORD })).status).toBe(200);
  });

  it("with no OPERATOR_EMAIL, the first sign-up owns the copy and the second is refused", async () => {
    const w = world({ operatorSet: false });
    const mine = unique("first");
    expect(await body(await w.device().call("GET", "/auth/me"))).toMatchObject({ signedIn: false, claimable: true });
    expect((await w.device().call("POST", "/auth/claim", { password: PASSWORD })).status).toBe(400);
    expect((await w.device().call("POST", "/auth/claim", { email: "not an address", password: PASSWORD })).status).toBe(400);

    const d = w.device();
    const claimed = await d.call("POST", "/auth/claim", { email: mine, password: PASSWORD });
    expect(claimed.status).toBe(200);
    expect(await body(claimed)).toMatchObject({ signedIn: true, recoveryCode: expect.any(String) });
    expect(await w.store.account(w.owner)).toMatchObject({ id: w.owner, email: mine, confirmed: true, hasPassword: true });
    expect(await body(await d.call("GET", "/auth/me"))).toMatchObject({ signedIn: true, operator: true, email: mine });

    expect(await body(await w.device().call("GET", "/auth/me"))).toMatchObject({ signedIn: false, claimable: false });
    const second = await w.device().call("POST", "/auth/claim", { email: unique("second"), password: PASSWORD });
    expect(second.status).toBe(409);
    expect(await body(second)).toEqual({ error: "This copy already has an owner." });
  });

  it("with no OPERATOR_EMAIL, an invite still works after the owner exists", async () => {
    const w = world({ operatorSet: false });
    const mine = unique("first");
    const d = w.device();
    expect((await d.call("POST", "/auth/claim", { email: mine, password: PASSWORD })).status).toBe(200);
    const friend = unique("friend");
    const token = await invite(d, friend);
    expect((await w.device().call("POST", "/auth/invite/accept", { token, password: PASSWORD })).status).toBe(200);
  });

  it("is the only one who invites", async () => {
    const w = world();
    const ordinary = await seed(w);
    const person = await signedIn(w, ordinary.email);
    expect((await w.device().call("POST", "/auth/invite", { email: unique("friend") })).status).toBe(401);
    expect((await person.call("POST", "/auth/invite", { email: unique("friend") })).status).toBe(403);
    expect((await person.call("GET", "/auth/invites")).status).toBe(403);
    expect((await w.device().call("GET", "/auth/invites")).status).toBe(401);
  });

  it("hands the owner the invite link, sends nothing, lists the pending, and refuses its own address and an existing account", async () => {
    const w = world();
    const op = await claim(w);
    const friend = unique("friend");

    expect((await op.call("POST", "/auth/invite", { email: w.operator })).status).toBe(409);
    expect((await op.call("POST", "/auth/invite", { email: "nonsense" })).status).toBe(400);
    const existing = await seed(w);
    expect((await op.call("POST", "/auth/invite", { email: existing.email })).status).toBe(409);

    const sent = await op.call("POST", "/auth/invite", { email: `  ${friend.toUpperCase()} ` });
    expect(sent.status).toBe(200);
    const { ok, link } = await body<{ ok: boolean; link: string }>(sent);
    expect(ok).toBe(true);
    expect(link).toMatch(new RegExp(`^${ORIGIN}/invite#[A-Za-z0-9_-]{43}$`));
    // The stub fetch throws on anything but Google's token endpoint, so nothing went out.
    expect(w.google.calls).toEqual([]);

    const listed = await body<{ invites: { email: string; expiresAt: string }[] }>(await op.call("GET", "/auth/invites"));
    expect(listed.invites.map((i) => i.email)).toEqual([friend]);
    expect(listed.invites[0]?.expiresAt).toBe("2026-09-21T02:00:00.000Z");
  });

  it("withdraws a waiting invite, so its link no longer opens an account", async () => {
    const w = world();
    const op = await claim(w);
    const friend = unique("friend");
    const token = await invite(op, friend);

    const ordinary = await signedIn(w, (await seed(w)).email);
    expect((await ordinary.call("POST", "/auth/invite/withdraw", { email: friend })).status).toBe(403);
    expect((await w.device().call("POST", "/auth/invite/withdraw", { email: friend })).status).toBe(401);
    expect((await op.call("POST", "/auth/invite/withdraw", { email: "nonsense" })).status).toBe(400);

    const withdrawn = await op.call("POST", "/auth/invite/withdraw", { email: ` ${friend.toUpperCase()} ` });
    expect(withdrawn.status).toBe(200);
    expect((await body<{ invites: unknown[] }>(await op.call("GET", "/auth/invites"))).invites).toEqual([]);
    expect((await w.device().call("POST", "/auth/invite/accept", { token, password: PASSWORD })).status).toBe(400);
    expect((await op.call("POST", "/auth/invite/withdraw", { email: friend })).status).toBe(404);
  });

  it("issues a waiting invite again with a new link, and the old link stops working", async () => {
    const w = world();
    const op = await claim(w);
    const friend = unique("friend");
    const first = await invite(op, friend);
    w.advance(60 * 60 * 1000);
    const second = await invite(op, friend);
    const listed = await body<{ invites: { expiresAt: string }[] }>(await op.call("GET", "/auth/invites"));
    expect(listed.invites.map((i) => i.expiresAt)).toEqual(["2026-09-21T03:00:00.000Z"]);
    expect((await w.device().call("POST", "/auth/invite/accept", { token: first, password: PASSWORD })).status).toBe(400);
    expect((await w.device().call("POST", "/auth/invite/accept", { token: second, password: PASSWORD })).status).toBe(200);
  });

  it("throttles invites at 3 per address an hour", async () => {
    const w = world();
    const op = await claim(w);
    const friend = unique("friend");
    for (let i = 0; i < 3; i++) expect((await op.call("POST", "/auth/invite", { email: friend })).status).toBe(200);
    expect((await op.call("POST", "/auth/invite", { email: friend })).status).toBe(429);
    // A repeat invitation replaced the earlier one.
    const listed = await body<{ invites: unknown[] }>(await op.call("GET", "/auth/invites"));
    expect(listed.invites).toHaveLength(1);
  });
});

describe("accepting an invite", () => {
  it("makes a confirmed tenant that starts empty and cannot see the operator's data", async () => {
    const w = world();
    const op = await claim(w);
    const friend = unique("friend");
    const token = await invite(op, friend);

    // The operator has a venture, so an empty overview below is not just an empty database.
    const made = await op.call("POST", "/api/ventures", { name: "Operator venture" });
    expect(made.status).toBeLessThan(300);
    expect(((await body<{ ventures: unknown[] }>(await op.call("GET", "/api/overview"))).ventures).length).toBeGreaterThan(0);

    const d = w.device();
    expect((await d.call("POST", "/auth/invite/accept", { token, password: "short" })).status).toBe(400);
    const accepted = await d.call("POST", "/auth/invite/accept", { token, password: PASSWORD });
    expect(accepted.status).toBe(200);

    const overview = await d.call("GET", "/api/overview");
    expect(overview.status).toBe(200);
    expect(await body(overview)).toEqual({ ventures: [], archivedVentures: 0 });
    expect(await body(await d.call("GET", "/auth/me"))).toMatchObject({ signedIn: true, email: friend, operator: false });

    const account = (await w.store.attempt(friend, [], "2026-09-14T02:00:00.000Z", "", "")).account;
    expect(account?.confirmed).toBe(true);
    expect(account?.id).not.toBe(w.owner);
    expect((await w.store.invites(w.owner))).toHaveLength(0);

    // Spent.
    expect((await w.device().call("POST", "/auth/invite/accept", { token, password: PASSWORD })).status).toBe(400);
    expect((await w.device().call("POST", "/auth/sign-in", { email: friend, password: PASSWORD })).status).toBe(200);
  });

  it("refuses an invite whose address has since got an account", async () => {
    const w = world();
    const op = await claim(w);
    const friend = unique("friend");
    const token = await invite(op, friend);
    await seed(w, { email: friend });
    expect((await w.device().call("POST", "/auth/invite/accept", { token, password: PASSWORD })).status).toBe(409);
  });

  it("refuses an expired invite", async () => {
    const w = world();
    const op = await claim(w);
    const token = await invite(op, unique("friend"));
    w.advance(8 * 24 * 60 * 60 * 1000);
    expect((await w.device().call("POST", "/auth/invite/accept", { token, password: PASSWORD })).status).toBe(400);
  });
});

describe("Google", () => {
  it("starts a flow with PKCE, state and nonce, in a short-lived Lax cookie", async () => {
    const w = world();
    const d = w.device();
    const response = await d.call("POST", "/auth/google/start", { intent: "sign-in" });
    expect(response.status).toBe(200);
    const url = new URL((await body<{ url: string }>(response)).url);
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(url.searchParams.get("client_id")).toBe(CLIENT.clientId);
    expect(url.searchParams.get("redirect_uri")).toBe(`${ORIGIN}/auth/google/callback`);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("state")).toBeTruthy();
    expect(url.searchParams.get("nonce")).toBeTruthy();
    expect(response.headers.get("set-cookie")).toMatch(/^__Host-vemi-google=.*Max-Age=600; HttpOnly; Secure; SameSite=Lax/);
  });

  it("refuses to start when unset, with a bad intent, or to link without a session", async () => {
    const off = world({ google: false });
    expect((await off.device().call("POST", "/auth/google/start", { intent: "sign-in" })).status).toBe(503);
    expect(await body(await off.device().call("GET", "/auth/me"))).toMatchObject({ googleReady: false });
    const callbackOff = await off.device().call("GET", "/auth/google/callback?code=x&state=y");
    expect(callbackOff.headers.get("location")).toBe("/#google=unavailable");

    const w = world();
    expect((await w.device().call("POST", "/auth/google/start", { intent: "nonsense" })).status).toBe(400);
    expect((await w.device().call("POST", "/auth/google/start", { intent: "link" })).status).toBe(401);
    expect((await w.device().call("POST", "/auth/google/start", { intent: "invite" })).status).toBe(400);
  });

  it("signs in the account that holds the sub", async () => {
    const w = world();
    const sub = `sub-${crypto.randomUUID()}`;
    const { email } = await seed(w, { googleSub: sub });
    w.google.claims = { sub, email: unique("changed-address"), email_verified: true };
    const d = w.device();
    const state = await startGoogle(w, d, { intent: "sign-in" });
    const response = await callback(d, state);

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/");
    expect(d.cookie("__Host-vemi")).toBeTruthy();
    expect(d.cookie("__Host-vemi-google")).toBeUndefined();
    expect(await body(await d.call("GET", "/auth/me"))).toMatchObject({ signedIn: true, email });
    expect((await d.call("GET", "/api/overview")).status).toBe(200);

    // The code was exchanged with the client secret and the PKCE verifier, and nowhere else.
    expect(w.google.calls).toEqual([GOOGLE_TOKEN]);
    expect(w.google.bodies[0]?.get("client_secret")).toBe(CLIENT.clientSecret);
    expect(w.google.bodies[0]?.get("code_verifier")).toBeTruthy();
  });

  it("links by a matching confirmed email, then keeps the sub", async () => {
    const w = world();
    const { email, id } = await seed(w);
    const sub = `sub-${crypto.randomUUID()}`;
    w.google.claims = { sub, email, email_verified: true };
    const d = w.device();
    const response = await callback(d, await startGoogle(w, d, { intent: "sign-in" }));
    expect(response.headers.get("location")).toBe("/#google=linked");
    expect((await w.store.account(id))?.googleSub).toBe(sub);
    expect((await d.call("GET", "/api/overview")).status).toBe(200);
  });

  it("does not link by the email of an unconfirmed account or one already linked elsewhere", async () => {
    const w = world();
    const unconfirmed = await seed(w, { confirmed: false });
    w.google.claims = { sub: `sub-${crypto.randomUUID()}`, email: unconfirmed.email, email_verified: true };
    let d = w.device();
    expect((await callback(d, await startGoogle(w, d, { intent: "sign-in" }))).headers.get("location")).toBe("/#google=unknown");

    const linked = await seed(w, { googleSub: `sub-${crypto.randomUUID()}` });
    w.google.claims = { sub: `sub-${crypto.randomUUID()}`, email: linked.email, email_verified: true };
    d = w.device();
    expect((await callback(d, await startGoogle(w, d, { intent: "sign-in" }))).headers.get("location")).toBe("/#google=other");
    expect(d.cookie("__Host-vemi")).toBeUndefined();
  });

  it("refuses an email Google has not verified", async () => {
    const w = world();
    const { email } = await seed(w);
    w.google.claims = { sub: `sub-${crypto.randomUUID()}`, email, email_verified: false };
    const d = w.device();
    const response = await callback(d, await startGoogle(w, d, { intent: "sign-in" }));
    expect(response.headers.get("location")).toBe("/#google=failed");
    expect(d.cookie("__Host-vemi")).toBeUndefined();
    expect((await w.store.accountsForGoogle("", email))[0]?.googleSub).toBeNull();
  });

  it("refuses an address that has no account", async () => {
    const w = world();
    w.google.claims = { sub: `sub-${crypto.randomUUID()}`, email: unique("stranger"), email_verified: true };
    const d = w.device();
    const response = await callback(d, await startGoogle(w, d, { intent: "sign-in" }));
    expect(response.headers.get("location")).toBe("/#google=unknown");
    expect(response.headers.get("set-cookie")).not.toContain("__Host-vemi=ey");
    expect(d.cookie("__Host-vemi")).toBeUndefined();
  });

  it("refuses a tampered, missing, mismatched or expired state", async () => {
    const w = world();
    const { email } = await seed(w);
    w.google.claims = { sub: `sub-${crypto.randomUUID()}`, email, email_verified: true };

    let d = w.device();
    let state = await startGoogle(w, d, { intent: "sign-in" });
    const cookie = d.cookie("__Host-vemi-google") ?? "";
    const [payload = "", signature = ""] = cookie.split(".");
    d.setCookie("__Host-vemi-google", `${payload}.${signature.slice(0, -2)}${signature.endsWith("AA") ? "BB" : "AA"}`);
    expect((await callback(d, state)).headers.get("location")).toBe("/#google=state");

    // A forged body under a copied signature.
    const forged = btoa(JSON.stringify({ state: "x", verifier: "v", nonce: "n", intent: "sign-in", expires: 9999999999 })).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
    d.setCookie("__Host-vemi-google", `${forged}.${signature}`);
    expect((await callback(d, "x")).headers.get("location")).toBe("/#google=state");

    d = w.device();
    state = await startGoogle(w, d, { intent: "sign-in" });
    expect((await callback(w.device(), state)).headers.get("location")).toBe("/#google=state");
    expect((await callback(d, "some-other-state")).headers.get("location")).toBe("/#google=state");

    d = w.device();
    state = await startGoogle(w, d, { intent: "sign-in" });
    w.advance(11 * 60 * 1000);
    expect((await callback(d, state)).headers.get("location")).toBe("/#google=state");
    expect(w.google.calls).toEqual([]);
  });

  it("refuses a cancelled consent, and cannot use a state twice", async () => {
    const w = world();
    const { email } = await seed(w);
    w.google.claims = { sub: `sub-${crypto.randomUUID()}`, email, email_verified: true };
    let d = w.device();
    expect((await callback(d, await startGoogle(w, d, { intent: "sign-in" }), "error=access_denied")).headers.get("location")).toBe("/#google=denied");

    d = w.device();
    const state = await startGoogle(w, d, { intent: "sign-in" });
    expect((await callback(d, state)).headers.get("location")).toBe("/#google=linked");
    expect((await callback(d, state)).headers.get("location")).toBe("/#google=state");
  });

  it("lets the first Google sign-in claim OWNER on a copy with no operator address, once", async () => {
    const w = world({ operatorSet: false });
    const email = unique("first-google");
    w.google.claims = { sub: `sub-${crypto.randomUUID()}`, email, email_verified: true };
    const d = w.device();
    expect((await callback(d, await startGoogle(w, d, { intent: "sign-in" }))).headers.get("location")).toBe("/");
    expect(await w.store.account(w.owner)).toMatchObject({ id: w.owner, email, google: true });
    w.google.claims = { sub: `sub-${crypto.randomUUID()}`, email: unique("late"), email_verified: true };
    const late = w.device();
    expect((await callback(late, await startGoogle(w, late, { intent: "sign-in" }))).headers.get("location")).toBe("/#google=unknown");
  });

  it("lets the operator claim OWNER with the operator address, once", async () => {
    const w = world();
    const sub = `sub-${crypto.randomUUID()}`;
    w.google.claims = { sub, email: w.operator, email_verified: true };
    const d = w.device();
    expect((await callback(d, await startGoogle(w, d, { intent: "sign-in" }))).headers.get("location")).toBe("/");
    expect(await w.store.account(w.owner)).toMatchObject({ id: w.owner, email: w.operator, confirmed: true, hasPassword: false, google: true });
    expect(await body(await d.call("GET", "/auth/me"))).toMatchObject({ operator: true });

    // A second claim finds the address taken and is refused.
    w.google.claims = { sub: `sub-${crypto.randomUUID()}`, email: w.operator, email_verified: true };
    const second = w.device();
    expect((await callback(second, await startGoogle(w, second, { intent: "sign-in" }))).headers.get("location")).toBe("/#google=other");
    // The same Google identity still signs in as the owner.
    w.google.claims = { sub, email: w.operator, email_verified: true };
    const again = w.device();
    expect((await callback(again, await startGoogle(w, again, { intent: "sign-in" }))).headers.get("location")).toBe("/");
  });

  it("links the sub to the signed-in account, from a callback that carries no session", async () => {
    const w = world();
    const { email, id } = await seed(w);
    const d = await signedIn(w, email);
    const state = await startGoogle(w, d, { intent: "link" });
    w.google.claims = { sub: `sub-${crypto.randomUUID()}`, email: unique("elsewhere"), email_verified: true };

    // Google's redirect is cross-site, so the Strict session cookie is not sent with it.
    const arriving = w.device();
    arriving.setCookie("__Host-vemi-google", d.cookie("__Host-vemi-google") ?? "");
    const response = await callback(arriving, state);
    expect(response.headers.get("location")).toBe("/account");
    expect((await w.store.account(id))?.googleSub).toBe(w.google.claims.sub);
    expect(await body(await d.call("GET", "/auth/me"))).toMatchObject({ google: true });
  });

  it("refuses to link a sub that another account holds", async () => {
    const w = world();
    const sub = `sub-${crypto.randomUUID()}`;
    await seed(w, { googleSub: sub });
    const { email, id } = await seed(w);
    const d = await signedIn(w, email);
    w.google.claims = { sub, email: unique("elsewhere"), email_verified: true };
    const response = await callback(d, await startGoogle(w, d, { intent: "link" }));
    expect(response.headers.get("location")).toBe("/#google=taken");
    expect((await w.store.account(id))?.googleSub).toBeNull();
  });

  it("makes the account from an invite, once", async () => {
    const w = world();
    const op = await claim(w);
    const friend = unique("friend");
    const token = await invite(op, friend);
    const sub = `sub-${crypto.randomUUID()}`;
    w.google.claims = { sub, email: unique("their-google"), email_verified: true };

    const d = w.device();
    const response = await callback(d, await startGoogle(w, d, { intent: "invite", token }));
    expect(response.headers.get("location")).toBe("/");
    expect(await body(await d.call("GET", "/auth/me"))).toMatchObject({ signedIn: true, email: friend, password: false, google: true, operator: false });
    expect(await body(await d.call("GET", "/api/overview"))).toEqual({ ventures: [], archivedVentures: 0 });

    const spent = w.device();
    expect((await callback(spent, await startGoogle(w, spent, { intent: "invite", token }))).headers.get("location")).toBe("/#google=invite");
  });

  it("keeps the invite when the Google account chosen is linked elsewhere", async () => {
    const w = world();
    const op = await claim(w);
    const friend = unique("friend");
    const token = await invite(op, friend);
    const sub = `sub-${crypto.randomUUID()}`;
    await seed(w, { googleSub: sub });
    w.google.claims = { sub, email: unique("their-google"), email_verified: true };

    const d = w.device();
    expect((await callback(d, await startGoogle(w, d, { intent: "invite", token }))).headers.get("location")).toBe("/#google=taken");
    expect(d.cookie("__Host-vemi")).toBeUndefined();
    // Nothing half made, and the same link still opens the account with a password.
    expect((await body<{ invites: { email: string }[] }>(await op.call("GET", "/auth/invites"))).invites.map((i) => i.email)).toEqual([friend]);
    const accepted = await w.device().call("POST", "/auth/invite/accept", { token, password: PASSWORD });
    expect(accepted.status).toBe(200);
  });

  it("unlinks only while a password remains", async () => {
    const w = world();
    const googleOnly = await seed(w, { password: null, googleSub: `sub-${crypto.randomUUID()}` });
    w.google.claims = { sub: (await w.store.account(googleOnly.id))?.googleSub ?? "", email: googleOnly.email, email_verified: true };
    const d = w.device();
    await callback(d, await startGoogle(w, d, { intent: "sign-in" }));

    const refused = await d.call("POST", "/auth/google/unlink", {});
    expect(refused.status).toBe(409);
    expect((await body<{ error: string }>(refused)).error).toContain("password");
    expect((await w.store.account(googleOnly.id))?.googleSub).not.toBeNull();

    expect((await d.call("POST", "/auth/password", { next: "a brand new passphrase" })).status).toBe(200);
    expect((await d.call("POST", "/auth/google/unlink", {})).status).toBe(200);
    expect(await body(await d.call("GET", "/auth/me"))).toMatchObject({ google: false, password: true });
    const notLinked = await d.call("POST", "/auth/google/unlink", {});
    expect(notLinked.status).toBe(409);
    expect((await body<{ error: string }>(notLinked)).error).toContain("not linked");
    expect((await w.device().call("POST", "/auth/google/unlink", {})).status).toBe(401);
  });
});
