import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { accountIdentity } from "./accountIdentity.js";
import { createApp } from "./app.js";
import { copyOrigin, sessionKey } from "./sessionKey.js";
import { openStore } from "./store.js";
import { testDb, type TestDb } from "./testing/d1.js";

/**
 * A copy starts with no secret set. The session key is made on first use and kept in D1, so a
 * restart keeps every session; `SESSION_SECRET`, `VAPID_PUBLIC` and `VAPID_PRIVATE` still win
 * when set; the export carries none of it; and the address comes from the first request unless
 * `ORIGIN` is set.
 */

const ORIGIN = "https://vemi.example.workers.dev";
const PASSWORD = "correct horse battery";

let t: TestDb;
beforeAll(async () => {
  t = await testDb();
});
afterAll(() => t.dispose());

/** One Worker's worth of app over the shared database: a fresh closure each time, as a restart makes. */
function worker(options: { secret?: string; vapid?: { publicKey?: string; privateKey?: string }; owner: string }) {
  const store = openStore({ DB: t.db });
  const identity = accountIdentity({
    store, now: () => new Date(), origin: ORIGIN, owner: options.owner, operatorEmail: `op-${options.owner}@example.com`,
    sessionSecret: () => sessionKey(store, options.secret), google: null,
    fetch: (async () => { throw new Error("no network"); }) as typeof fetch,
  });
  const app = createApp({
    store, identity, now: () => new Date(), origin: ORIGIN, timeZone: "UTC", copyOwner: options.owner,
    ...(options.vapid === undefined ? {} : { vapid: options.vapid }),
    live: { publish: async () => {}, connect: async () => new Response("connected") },
  });
  const call = (method: string, path: string, cookie = "", body?: unknown): Promise<Response> =>
    app(new Request(`${ORIGIN}${path}`, {
      method,
      headers: { origin: ORIGIN, "cf-connecting-ip": "10.1.1.1", ...(cookie ? { cookie } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    }), () => {});
  return { store, call };
}

describe("the session key", () => {
  it("is made on first use, 32 random bytes as base64url, and is the same on every later call", async () => {
    const store = openStore({ DB: t.db });
    expect(await store.sessionKey()).toBeNull();
    const first = await sessionKey(store);
    expect(first).toMatch(/^[\w-]{43}$/);
    expect(await sessionKey(store)).toBe(first);
    expect(await store.sessionKey()).toBe(first);
  });

  it("ends on one key when two Workers race on a fresh database", async () => {
    const fresh = await testDb();
    try {
      const a = openStore({ DB: fresh.db });
      const b = openStore({ DB: fresh.db });
      const [x, y, z] = await Promise.all([sessionKey(a), sessionKey(b), sessionKey(a)]);
      expect(y).toBe(x);
      expect(z).toBe(x);
      expect(await a.sessionKey()).toBe(x);
    } finally {
      await fresh.dispose();
    }
  });

  it("is replaced by SESSION_SECRET when that is set, and the kept one is left alone", async () => {
    const store = openStore({ DB: t.db });
    const kept = await sessionKey(store);
    expect(await sessionKey(store, "my own secret")).toBe("my own secret");
    expect(await store.sessionKey()).toBe(kept);
  });

  it("keeps a session signed before a restart valid after it, and a set secret signs differently", async () => {
    const owner = `owner-${crypto.randomUUID()}`;
    const before = worker({ owner });
    const claimed = await before.call("POST", "/auth/claim", "", { email: `op-${owner}@example.com`, password: PASSWORD });
    expect(claimed.status).toBe(200);
    const cookie = (claimed.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    expect((await before.call("GET", "/api/overview", cookie)).status).toBe(200);

    const after = worker({ owner });
    expect((await after.call("GET", "/api/overview", cookie)).status).toBe(200);

    const own = worker({ owner, secret: "a different secret" });
    expect((await own.call("GET", "/api/overview", cookie)).status).toBe(401);
  });

  it("is never in the export", async () => {
    const owner = `owner-${crypto.randomUUID()}`;
    const w = worker({ owner });
    const claimed = await w.call("POST", "/auth/claim", "", { email: `op-${owner}@example.com`, password: PASSWORD });
    const cookie = (claimed.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    const kept = await w.store.sessionKey();
    expect(kept).not.toBeNull();
    const text = await (await w.call("GET", "/api/export", cookie)).text();
    expect(text).not.toContain(kept ?? "never");
    const doc = JSON.parse(text) as { tables: Record<string, unknown[]> };
    expect(doc.tables["session_key"] ?? []).toEqual([]);
  });
});

describe("the push pair", () => {
  it("is made on the first /api/push/key call when nothing is set", async () => {
    const owner = `owner-${crypto.randomUUID()}`;
    const w = worker({ owner });
    const cookie = ((await w.call("POST", "/auth/claim", "", { email: `op-${owner}@example.com`, password: PASSWORD })).headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    const made = (await (await w.call("GET", "/api/push/key", cookie)).json()) as { publicKey: string };
    expect(made.publicKey).toHaveLength(87);
    expect((await w.store.vapidKey())?.publicKey).toBe(made.publicKey);
  });

  it("is the one in VAPID_PUBLIC and VAPID_PRIVATE when both are set", async () => {
    const owner = `owner-${crypto.randomUUID()}`;
    const w = worker({ owner, vapid: { publicKey: "SET-PUBLIC", privateKey: "SET-PRIVATE" } });
    const cookie = ((await w.call("POST", "/auth/claim", "", { email: `op-${owner}@example.com`, password: PASSWORD })).headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    expect(await (await w.call("GET", "/api/push/key", cookie)).json()).toEqual({ publicKey: "SET-PUBLIC" });
  });
});

describe("the origin", () => {
  it("is taken from the first request when ORIGIN is unset or empty, and ORIGIN wins when set", () => {
    const request = new Request("http://127.0.0.1:8787/api/overview");
    expect(copyOrigin(undefined, request)).toBe("http://127.0.0.1:8787");
    expect(copyOrigin("", request)).toBe("http://127.0.0.1:8787");
    expect(copyOrigin("https://vemi.example.org", request)).toBe("https://vemi.example.org");
  });
});
