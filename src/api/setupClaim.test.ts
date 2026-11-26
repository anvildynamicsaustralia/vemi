import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { accountIdentity } from "./accountIdentity.js";
import { createApp } from "./app.js";
import { sessionKey } from "./sessionKey.js";
import { createSetup, openToken, sealToken } from "./setup.js";
import { openStore } from "./store.js";
import { testDb, type TestDb } from "./testing/d1.js";

/**
 * The hand-over from the setup page: a copy with `SETUP_CLAIM` set refuses a first sign-up until
 * the code has been used once; the token is kept sealed only when asked; a copy without the
 * secret behaves as it always did.
 */

const ORIGIN = "https://vemi.example.workers.dev";
const FROM = "https://setup.example.org";
const CODE = "a-setup-code-only-the-page-knows";
const TOKEN = "cf-token-value-for-tests-0123456789";
const PASSWORD = "correct horse battery";

let t: TestDb;
beforeAll(async () => {
  t = await testDb();
});
afterAll(() => t.dispose());

/** A fresh database per copy, so each test starts unclaimed. */
async function copy(options: { claim?: string | undefined; from?: string }) {
  const db = await testDb();
  const store = openStore({ DB: db.db });
  const identity = accountIdentity({
    store, now: () => new Date(), origin: ORIGIN, owner: "owner", operatorEmail: "",
    sessionSecret: () => sessionKey(store), google: null, setupClaim: Boolean(options.claim),
    fetch: (async () => { throw new Error("no network"); }) as typeof fetch,
  });
  const app = createApp({
    store, identity, now: () => new Date(), origin: ORIGIN, timeZone: "UTC", copyOwner: "owner",
    ...(options.claim ? { setup: createSetup({ store, secret: options.claim, from: options.from ?? FROM, origin: ORIGIN }) } : {}),
    live: { publish: async () => {}, connect: async () => new Response("connected") },
  });
  const call = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Response> =>
    app(new Request(`${ORIGIN}${path}`, {
      method,
      headers: { origin: ORIGIN, "cf-connecting-ip": "10.1.1.1", ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    }), () => {});
  const signUp = () => call("POST", "/auth/claim", { email: "me@example.com", password: PASSWORD });
  return { store, call, signUp, dispose: () => db.dispose() };
}

describe("the store's setup claim", () => {
  it("is empty at first, keeps the first claim, and a second cannot replace it", async () => {
    const store = openStore({ DB: t.db });
    expect(await store.setupClaim()).toBeNull();
    const first = await store.keepSetupClaim("sealed-one", true);
    expect(first.made).toBe(true);
    expect(first.claim).toMatchObject({ sealedToken: "sealed-one", keepUpdated: true });
    const second = await store.keepSetupClaim(null, false);
    expect(second.made).toBe(false);
    expect(second.claim).toEqual(first.claim);
    expect(await store.setupClaim()).toEqual(first.claim);
  });

  it("is a table with an owner and archived_at, so nothing is deleted from it", async () => {
    const cols = await t.db.prepare(`SELECT name FROM pragma_table_info('setup_claim')`).all<{ name: string }>();
    const names = cols.results.map((c) => c.name);
    expect(names).toEqual(expect.arrayContaining(["id", "claimed_at", "sealed_token", "keep_updated", "owner", "created_at", "archived_at"]));
  });
});

describe("sealing", () => {
  it("opens only under the same secret and address, and never holds the token in the clear", async () => {
    const sealed = await sealToken(TOKEN, CODE, ORIGIN);
    expect(sealed).not.toContain(TOKEN);
    expect(await openToken(sealed, CODE, ORIGIN)).toBe(TOKEN);
    expect(await openToken(sealed, "another code", ORIGIN)).toBeNull();
    expect(await openToken(sealed, CODE, "https://elsewhere.example.org")).toBeNull();
    expect(await sealToken(TOKEN, CODE, ORIGIN)).not.toBe(sealed);
  });
});

describe("POST /setup/claim", () => {
  it("refuses a first sign-up until the code is used, then lets the first sign-up make the owner", async () => {
    const c = await copy({ claim: CODE });
    try {
      expect(await (await c.call("GET", "/auth/me")).json()).toMatchObject({ claimable: false });
      expect((await c.signUp()).status).toBe(409);
      const taken = await c.call("POST", "/setup/claim", { code: CODE, token: TOKEN, keepUpdated: true });
      expect(taken.status).toBe(200);
      expect(await (await c.call("GET", "/auth/me")).json()).toMatchObject({ claimable: true });
      expect((await c.signUp()).status).toBe(200);
      expect((await c.signUp()).status).toBe(409);
    } finally {
      await c.dispose();
    }
  });

  it("accepts the code once and refuses every later call and every wrong code the same way", async () => {
    const c = await copy({ claim: CODE });
    try {
      const wrong = await c.call("POST", "/setup/claim", { code: "nope", token: TOKEN, keepUpdated: true });
      expect(wrong.status).toBe(403);
      const wrongBody = await wrong.text();
      expect((await c.store.setupClaim())).toBeNull();

      expect((await c.call("POST", "/setup/claim", { code: CODE, token: TOKEN, keepUpdated: false })).status).toBe(200);
      const again = await c.call("POST", "/setup/claim", { code: CODE, token: TOKEN, keepUpdated: false });
      expect(again.status).toBe(403);
      expect(await again.text()).toBe(wrongBody);
      const wrongLater = await c.call("POST", "/setup/claim", { code: "nope", token: TOKEN, keepUpdated: false });
      expect(wrongLater.status).toBe(403);
      expect(await wrongLater.text()).toBe(wrongBody);
      expect((await c.call("GET", "/setup/claim")).status).toBe(403);
    } finally {
      await c.dispose();
    }
  });

  it("stays claimed after Update myself is turned off: the code is not accepted again", async () => {
    const c = await copy({ claim: CODE });
    try {
      expect((await c.call("POST", "/setup/claim", { code: CODE, token: TOKEN, keepUpdated: true })).status).toBe(200);
      expect(await c.store.removeSetupKey()).toBe(true);
      expect(await c.store.setupClaim()).toMatchObject({ sealedToken: null, keepUpdated: false });
      expect(await c.store.removeSetupKey()).toBe(false);

      const again = await c.call("POST", "/setup/claim", { code: CODE, token: TOKEN, keepUpdated: true });
      expect(again.status).toBe(403);
      expect(await c.store.setupClaim()).toMatchObject({ sealedToken: null, keepUpdated: false });
    } finally {
      await c.dispose();
    }
  });

  it("lets only one of two racing calls claim", async () => {
    const c = await copy({ claim: CODE });
    try {
      const body = { code: CODE, token: TOKEN, keepUpdated: true };
      const results = await Promise.all([c.call("POST", "/setup/claim", body), c.call("POST", "/setup/claim", body), c.call("POST", "/setup/claim", body)]);
      expect(results.map((r) => r.status).sort()).toEqual([200, 403, 403]);
    } finally {
      await c.dispose();
    }
  });

  it("seals the token when keepUpdated is true, and stores nothing when it is false", async () => {
    const kept = await copy({ claim: CODE });
    const dropped = await copy({ claim: CODE });
    try {
      await kept.call("POST", "/setup/claim", { code: CODE, token: TOKEN, keepUpdated: true });
      const row = await kept.store.setupClaim();
      expect(row?.keepUpdated).toBe(true);
      expect(row?.sealedToken).not.toBeNull();
      expect(row?.sealedToken).not.toContain(TOKEN);
      expect(await openToken(row?.sealedToken ?? "", CODE, ORIGIN)).toBe(TOKEN);

      await dropped.call("POST", "/setup/claim", { code: CODE, token: TOKEN, keepUpdated: false });
      expect(await dropped.store.setupClaim()).toMatchObject({ sealedToken: null, keepUpdated: false });
    } finally {
      await kept.dispose();
      await dropped.dispose();
    }
  });

  it("asks for a token when it is to be kept, without using the code up", async () => {
    const c = await copy({ claim: CODE });
    try {
      expect((await c.call("POST", "/setup/claim", { code: CODE, keepUpdated: true })).status).toBe(400);
      expect((await c.call("POST", "/setup/claim", { code: CODE, token: TOKEN })).status).toBe(400);
      expect(await c.store.setupClaim()).toBeNull();
    } finally {
      await c.dispose();
    }
  });

  it("answers CORS only for the exact SETUP_FROM origin, and only while unclaimed", async () => {
    const c = await copy({ claim: CODE });
    try {
      const preflight = await c.call("OPTIONS", "/setup/claim", undefined, { origin: FROM });
      expect(preflight.headers.get("access-control-allow-origin")).toBe(FROM);
      const other = await c.call("OPTIONS", "/setup/claim", undefined, { origin: "https://evil.example.org" });
      expect(other.headers.get("access-control-allow-origin")).toBeNull();
      const near = await c.call("OPTIONS", "/setup/claim", undefined, { origin: `${FROM}.evil.example.org` });
      expect(near.headers.get("access-control-allow-origin")).toBeNull();

      const done = await c.call("POST", "/setup/claim", { code: CODE, token: TOKEN, keepUpdated: false }, { origin: FROM });
      expect(done.status).toBe(200);
      expect(done.headers.get("access-control-allow-origin")).toBe(FROM);

      const after = await c.call("POST", "/setup/claim", { code: CODE, token: TOKEN, keepUpdated: false }, { origin: FROM });
      expect(after.status).toBe(403);
      expect(after.headers.get("access-control-allow-origin")).toBeNull();
      expect((await c.call("OPTIONS", "/setup/claim", undefined, { origin: FROM })).headers.get("access-control-allow-origin")).toBeNull();
    } finally {
      await c.dispose();
    }
  });

  it("answers no CORS at all when SETUP_FROM is empty", async () => {
    const c = await copy({ claim: CODE, from: "" });
    try {
      const res = await c.call("OPTIONS", "/setup/claim", undefined, { origin: FROM });
      expect(res.headers.get("access-control-allow-origin")).toBeNull();
    } finally {
      await c.dispose();
    }
  });

  it("refuses the Google first-account branch's equivalent too: a copy waiting for the code is not claimable", async () => {
    const c = await copy({ claim: CODE });
    try {
      expect(await (await c.call("GET", "/auth/me")).json()).toMatchObject({ claimable: false });
    } finally {
      await c.dispose();
    }
  });
});

describe("a copy with no SETUP_CLAIM", () => {
  it("behaves as it does today: claimable at once, and /setup/claim is not a route", async () => {
    const c = await copy({});
    try {
      expect(await (await c.call("GET", "/auth/me")).json()).toMatchObject({ claimable: true });
      expect((await c.call("POST", "/setup/claim", { code: CODE, token: TOKEN, keepUpdated: true })).status).toBe(404);
      expect(await c.store.setupClaim()).toBeNull();
      expect((await c.signUp()).status).toBe(200);
    } finally {
      await c.dispose();
    }
  });
});

describe("the sealed token stays inside", () => {
  it("is not in the export, any other answer, or a log line", async () => {
    const logs: string[] = [];
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation((...args: unknown[]) => { logs.push(args.map(String).join(" ")); }));
    const c = await copy({ claim: CODE });
    try {
      await c.call("POST", "/setup/claim", { code: CODE, token: TOKEN, keepUpdated: true });
      const sealed = (await c.store.setupClaim())?.sealedToken ?? "";
      expect(sealed).not.toBe("");
      const signed = await c.signUp();
      const cookie = (signed.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
      const answers = [
        await c.call("GET", "/api/export", undefined, { cookie }),
        await c.call("GET", "/api/overview", undefined, { cookie }),
        await c.call("GET", "/auth/me", undefined, { cookie }),
        await c.call("GET", "/api/front"),
      ];
      for (const res of answers) {
        const text = await res.text();
        expect(text).not.toContain(sealed);
        expect(text).not.toContain(TOKEN);
        expect(text).not.toContain(CODE);
      }
      const doc = JSON.parse(await (await c.call("GET", "/api/export", undefined, { cookie })).text()) as { tables: Record<string, unknown[]> };
      expect(doc.tables["setup_claim"] ?? []).toEqual([]);
      for (const line of logs) {
        expect(line).not.toContain(sealed);
        expect(line).not.toContain(TOKEN);
        expect(line).not.toContain(CODE);
      }
    } finally {
      for (const spy of spies) spy.mockRestore();
      await c.dispose();
    }
  });
});
