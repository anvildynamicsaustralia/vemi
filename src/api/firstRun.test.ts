import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { accountIdentity } from "./accountIdentity.js";
import { createApp } from "./app.js";
import { hashPassword } from "./password.js";
import { openStore } from "./store.js";
import { testDb, type TestDb } from "./testing/d1.js";

/** First-run progress on the account, through `createApp` and a real D1. */

const ORIGIN = "https://vemi.example.workers.dev";
const PASSWORD = "correct horse battery";
const LATER = "2999-01-01T00:00:00.000Z";

let t: TestDb;
beforeAll(async () => {
  t = await testDb();
});
afterAll(() => t.dispose());

type Json = Record<string, any>;

function world() {
  const copyOwner = `copy-owner-${crypto.randomUUID()}`;
  const operator = `op-${crypto.randomUUID()}@example.com`;
  const clock = () => new Date("2026-09-14T02:00:00Z");
  const store = openStore({ DB: t.db }, clock);
  const identity = accountIdentity({
    store, now: clock, origin: ORIGIN, owner: copyOwner, operatorEmail: operator, sessionSecret: "session-secret",
    google: null, fetch: (async () => { throw new Error("no network"); }) as typeof fetch,
  });
  const app = createApp({
    store, identity, now: clock, origin: ORIGIN, timeZone: "Australia/Sydney", copyOwner,
    live: { publish: async () => {}, connect: async () => new Response("connected") },
  });
  let devices = 0;
  function person() {
    const jar = new Map<string, string>();
    const ip = `10.9.${++devices}.${Math.floor(Math.random() * 250)}`;
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
    return { send, get: () => send("GET", "/api/first-run"), patch: (b: unknown) => send("PATCH", "/api/first-run", b) };
  }
  /** Someone signed in to an account the test made with `make`. */
  async function signedIn(make: (id: string, email: string) => Promise<void>) {
    const id = `acct-${crypto.randomUUID()}`;
    const email = `p-${crypto.randomUUID()}@example.com`;
    await make(id, email);
    const p = person();
    expect((await p.send("POST", "/auth/sign-in", { email, password: PASSWORD })).status).toBe(200);
    return { ...p, id };
  }
  return { store, copyOwner, operator, person, signedIn };
}

describe("first-run progress", () => {
  it("starts a claimed account at step 1 with an empty tip list", async () => {
    const w = world();
    const owner = w.person();
    const claimed = await owner.send("POST", "/auth/claim", { email: w.operator, password: PASSWORD });
    expect(claimed.status).toBe(200);
    expect(await owner.get()).toEqual({ status: 200, json: { step: 1, tipsSeen: [] } });
  });

  it("starts an account made by createAccount at step 1", async () => {
    const w = world();
    const p = await w.signedIn(async (id, email) => {
      expect(await w.store.createAccount({ id, email, passwordHash: await hashPassword(PASSWORD), googleSub: null, confirmed: true })).toBe(true);
    });
    expect((await p.get()).json).toEqual({ step: 1, tipsSeen: [] });
  });

  it("starts an account made from an email invite at step 1", async () => {
    const w = world();
    const email = `i-${crypto.randomUUID()}@example.com`;
    const token = `token-${crypto.randomUUID()}`;
    await w.store.putEmailToken({ id: token, owner: w.copyOwner, purpose: "invite", email, expiresAt: LATER });
    const id = `acct-${crypto.randomUUID()}`;
    expect(await w.store.acceptInvite(token, { id, passwordHash: await hashPassword(PASSWORD), googleSub: null })).toEqual({ made: true, email });
    expect(await w.store.firstRun(id)).toEqual({ step: 1, tipsSeen: [] });
  });

  it("starts an account made from a by-name invite at step 1", async () => {
    const w = world();
    const owner = w.person();
    expect((await owner.send("POST", "/auth/claim", { email: w.operator, password: PASSWORD })).status).toBe(200);
    const invite = `invite-${crypto.randomUUID()}`;
    await w.store.putInvite({ id: invite, owner: w.copyOwner, firstName: "Sam", expiresAt: LATER });
    const id = `acct-${crypto.randomUUID()}`;
    const email = `n-${crypto.randomUUID()}@example.com`;
    expect(await w.store.acceptPersonInvite(invite, { id, email, passwordHash: await hashPassword(PASSWORD), googleSub: null })).toEqual({ made: true });
    expect(await w.store.firstRun(id)).toEqual({ step: 1, tipsSeen: [] });
  });

  it("leaves an account made before this with no step and no tips", async () => {
    const w = world();
    const p = await w.signedIn(async (id, email) => {
      const at = "2020-01-01T00:00:00.000Z";
      await t.db.prepare(`INSERT INTO tenant (id, created_at) VALUES (?, ?)`).bind(id, at).run();
      await t.db.prepare(`INSERT INTO account (id, email, email_confirmed_at, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`)
        .bind(id, email, at, await hashPassword(PASSWORD), at, at).run();
    });
    expect((await p.get()).json).toEqual({ step: null, tipsSeen: null });
  });

  it("moves the step, and ends the steps with null", async () => {
    const w = world();
    const p = await w.signedIn(async (id, email) => {
      await w.store.createAccount({ id, email, passwordHash: await hashPassword(PASSWORD), googleSub: null, confirmed: true });
    });
    expect(await p.patch({ step: 4 })).toEqual({ status: 200, json: { step: 4, tipsSeen: [] } });
    expect((await p.get()).json.step).toBe(4);
    expect(await p.patch({ step: 7 })).toEqual({ status: 200, json: { step: 7, tipsSeen: [] } });
    expect(await p.patch({ step: null })).toEqual({ status: 200, json: { step: null, tipsSeen: [] } });
    expect((await p.get()).json).toEqual({ step: null, tipsSeen: [] });
  });

  it("appends a tip once, and keeps at most 20", async () => {
    const w = world();
    const p = await w.signedIn(async (id, email) => {
      await w.store.createAccount({ id, email, passwordHash: await hashPassword(PASSWORD), googleSub: null, confirmed: true });
    });
    expect((await p.patch({ tipSeen: "map" })).json.tipsSeen).toEqual(["map"]);
    expect((await p.patch({ tipSeen: "map" })).json.tipsSeen).toEqual(["map"]);
    expect((await p.patch({ tipSeen: "today" })).json.tipsSeen).toEqual(["map", "today"]);
    for (let n = 0; n < 25; n++) await p.patch({ tipSeen: `tip-${"a".repeat(n % 20 + 1)}-${String.fromCharCode(97 + (n % 26))}` });
    const list = (await p.get()).json.tipsSeen as string[];
    expect(list).toHaveLength(20);
    expect(new Set(list).size).toBe(20);
  });

  it("ignores a tip for an account whose list is null, and its steps still move", async () => {
    const w = world();
    const p = await w.signedIn(async (id, email) => {
      const at = "2020-01-01T00:00:00.000Z";
      await t.db.prepare(`INSERT INTO tenant (id, created_at) VALUES (?, ?)`).bind(id, at).run();
      await t.db.prepare(`INSERT INTO account (id, email, email_confirmed_at, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`)
        .bind(id, email, at, await hashPassword(PASSWORD), at, at).run();
    });
    expect(await p.patch({ tipSeen: "map" })).toEqual({ status: 200, json: { step: null, tipsSeen: null } });
    expect((await p.patch({ step: 2 })).json).toEqual({ step: 2, tipsSeen: null });
  });

  it("refuses anything but exactly one of a step or a tip name", async () => {
    const w = world();
    const p = await w.signedIn(async (id, email) => {
      await w.store.createAccount({ id, email, passwordHash: await hashPassword(PASSWORD), googleSub: null, confirmed: true });
    });
    const bad: unknown[] = [
      {}, { step: 0 }, { step: 8 }, { step: 1.5 }, { step: "2" }, { step: true },
      { tipSeen: "Map" }, { tipSeen: "" }, { tipSeen: "a".repeat(33) }, { tipSeen: "map1" }, { tipSeen: 3 }, { tipSeen: null },
      { step: 2, tipSeen: "map" }, { step: 2, extra: 1 }, { other: 1 }, [], "step",
    ];
    for (const body of bad) expect((await p.patch(body)).status, JSON.stringify(body)).toBe(400);
    expect((await p.get()).json).toEqual({ step: 1, tipsSeen: [] });
    expect((await p.patch({ tipSeen: "a".repeat(32) })).status).toBe(200);
    expect((await p.send("DELETE", "/api/first-run")).status).toBe(405);
  });

  it("answers 401 when nobody is signed in", async () => {
    const w = world();
    const nobody = w.person();
    expect((await nobody.get()).status).toBe(401);
    expect((await nobody.patch({ step: null })).status).toBe(401);
  });

  it("is each account's own", async () => {
    const w = world();
    const make = (id: string, email: string) => hashPassword(PASSWORD).then(async (passwordHash) => {
      await w.store.createAccount({ id, email, passwordHash, googleSub: null, confirmed: true });
    });
    const a = await w.signedIn(make);
    const b = await w.signedIn(make);
    await a.patch({ step: 6 });
    await a.patch({ tipSeen: "map" });
    expect((await b.get()).json).toEqual({ step: 1, tipsSeen: [] });
    await b.patch({ step: null });
    expect((await a.get()).json).toEqual({ step: 6, tipsSeen: ["map"] });
  });

  it("is not part of the settings, the export or a restore", async () => {
    const w = world();
    const p = await w.signedIn(async (id, email) => {
      await w.store.createAccount({ id, email, passwordHash: await hashPassword(PASSWORD), googleSub: null, confirmed: true });
    });
    expect(await w.store.appearance(p.id)).not.toHaveProperty("step");
    expect(await w.store.appearance(p.id)).not.toHaveProperty("tipsSeen");
    expect(JSON.stringify(await w.store.exportAll(p.id, new Date("2026-09-14T02:00:00Z")))).not.toMatch(/first_run_step|tips_seen|tipsSeen|firstRun/);
  });
});
