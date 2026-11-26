import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { accountIdentity } from "./accountIdentity.js";
import { createApp } from "./app.js";
import { hashPassword } from "./password.js";
import { openStore } from "./store.js";
import { testDb, type TestDb } from "./testing/d1.js";

/** The front page setting, through `createApp` and a real D1. */

const ORIGIN = "https://vemi.example.workers.dev";
const PASSWORD = "correct horse battery";

let t: TestDb;
beforeAll(async () => {
  t = await testDb();
});
afterAll(() => t.dispose());

type Json = Record<string, any>;

function world() {
  const copyOwner = `copy-owner-${crypto.randomUUID()}`;
  const clock = () => new Date("2026-09-14T02:00:00Z");
  const store = openStore({ DB: t.db }, clock);
  const identity = accountIdentity({
    store, now: clock, origin: ORIGIN, owner: copyOwner, operatorEmail: "", sessionSecret: "session-secret",
    google: null, fetch: (async () => { throw new Error("no network"); }) as typeof fetch,
  });
  const app = createApp({
    store, identity, now: clock, origin: ORIGIN, timeZone: "Australia/Sydney", copyOwner,
    live: { publish: async () => {}, connect: async () => new Response("connected") },
  });
  let devices = 0;
  /** Someone at the address: signed in as `id` when `signIn` is true, else nobody. */
  async function visitor(id: string | null) {
    const jar = new Map<string, string>();
    const ip = `10.8.${++devices}.${Math.floor(Math.random() * 250)}`;
    const send = async (method: string, path: string, body?: unknown) => {
      const response = await app(new Request(`${ORIGIN}${path}`, {
        method,
        headers: {
          origin: ORIGIN, "cf-connecting-ip": ip,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
          ...(jar.size > 0 ? { cookie: [...jar].map(([k, v]) => `${k}=${v}`).join("; ") } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      }), () => {});
      for (const line of response.headers.getSetCookie()) {
        const [pair = ""] = line.split(";");
        const at = pair.indexOf("=");
        const value = pair.slice(at + 1);
        if (/Max-Age=0/i.test(line) || value === "") jar.delete(pair.slice(0, at));
        else jar.set(pair.slice(0, at), value);
      }
      return { status: response.status, json: (await response.json()) as Json };
    };
    if (id !== null) {
      const email = `p-${crypto.randomUUID()}@example.com`;
      expect(await store.createAccount({ id, email, passwordHash: await hashPassword(PASSWORD), googleSub: null, confirmed: true })).toBe(true);
      expect((await send("POST", "/auth/sign-in", { email, password: PASSWORD })).status).toBe(200);
    }
    return { get: (p: string) => send("GET", p), patch: (p: string, b: unknown) => send("PATCH", p, b) };
  }
  return { store, visitor, copyOwner };
}

describe("the front page setting", () => {
  it("is on by default, and anyone can read it without signing in", async () => {
    const w = world();
    const nobody = await w.visitor(null);
    expect(await nobody.get("/api/front")).toEqual({ status: 200, json: { landing: true } });
  });

  it("is changed by the owner of the copy and read back signed out", async () => {
    const w = world();
    const owner = await w.visitor(w.copyOwner);
    expect(await owner.patch("/api/front", { landing: false })).toEqual({ status: 200, json: { landing: false } });
    const nobody = await w.visitor(null);
    expect((await nobody.get("/api/front")).json).toEqual({ landing: false });
    expect((await owner.patch("/api/front", { landing: true })).json).toEqual({ landing: true });
    expect((await nobody.get("/api/front")).json).toEqual({ landing: true });
  });

  it("refuses a person invited to the copy, and changes nothing", async () => {
    const w = world();
    const guest = await w.visitor(`guest-${crypto.randomUUID()}`);
    const refused = await guest.patch("/api/front", { landing: false });
    expect(refused.status).toBe(403);
    expect(await w.store.frontLanding()).toBe(true);
  });

  it("refuses a signed-out change with 401", async () => {
    const w = world();
    const nobody = await w.visitor(null);
    expect((await nobody.patch("/api/front", { landing: false })).status).toBe(401);
    expect(await w.store.frontLanding()).toBe(true);
  });

  it("takes only a true or false landing", async () => {
    const w = world();
    const owner = await w.visitor(w.copyOwner);
    expect((await owner.patch("/api/front", {})).status).toBe(400);
    expect((await owner.patch("/api/front", { landing: "no" })).status).toBe(400);
    expect((await owner.patch("/api/front", { landing: false, extra: 1 })).status).toBe(400);
    expect(await w.store.frontLanding()).toBe(true);
  });
});
