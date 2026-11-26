import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openLocalStore, type Store } from "../api/store.js";
import { applyMigrations, bundledMigrations } from "./migrate.js";
import { createSqlBinding, type SqlEngine } from "./sqlD1.js";
import { openSqliteEngine } from "./sqliteEngine.js";
import { LOCAL_OWNER, localIdentity } from "./identity.js";
import { LOCAL_KEY_NAME } from "../web/local/mode.js";

let engine: SqlEngine;
let store: Store;
beforeEach(async () => {
  engine = await openSqliteEngine();
  await applyMigrations(engine, await bundledMigrations());
  store = openLocalStore(createSqlBinding(engine));
});
afterEach(async () => {
  await engine.close();
});

const get = (path: string) => new Request(`https://vemi.test${path}`);
const post = (path: string) => new Request(`https://vemi.test${path}`, { method: "POST", body: "{}", headers: { "content-type": "application/json" } });
const later = (): void => undefined;

describe("the identity of a copy that lives in the page", () => {
  it("makes the one account on first open, in the device's time zone, and says signed in", async () => {
    const identity = localIdentity({ store, timeZone: "Pacific/Auckland" });
    expect(await store.account(LOCAL_OWNER)).toBeNull();
    const response = await identity.handle(get("/auth/me"), later);
    expect(response?.status).toBe(200);
    const me = await response!.json();
    expect(me.email).toBe(LOCAL_KEY_NAME);
    expect(me).toMatchObject({ signedIn: true, id: "local", password: false, google: false, twoStep: false, googleReady: false, deleteOn: null });
    expect(await store.account(LOCAL_OWNER)).not.toBeNull();
    expect((await store.appearance(LOCAL_OWNER)).timeZone).toBe("Pacific/Auckland");
  });

  it("opens again without making a second account or moving the zone", async () => {
    await localIdentity({ store, timeZone: "Pacific/Auckland" }).handle(get("/auth/me"), later);
    await store.setAppearance(LOCAL_OWNER, { timeZone: "Australia/Sydney" });
    const again = localIdentity({ store, timeZone: "Pacific/Auckland" });
    expect((await again.handle(get("/auth/me"), later))?.status).toBe(200);
    expect((await store.appearance(LOCAL_OWNER)).timeZone).toBe("Australia/Sydney");
    const rows = await engine.run(`SELECT count(*) FROM account`, []);
    expect(rows.rows[0]).toEqual([1]);
  });

  it("does not try to make the account again once it is there, so the console stays quiet on every open", async () => {
    await localIdentity({ store, timeZone: "UTC" }).handle(get("/auth/me"), later);
    const sql: string[] = [];
    const transaction = engine.transaction.bind(engine);
    engine.transaction = (fn) => transaction((tx) => fn({ ...tx, run: (text, binds) => { sql.push(text); return tx.run(text, binds); } }));
    const run = engine.run.bind(engine);
    engine.run = (text, binds) => { sql.push(text); return run(text, binds); };
    await localIdentity({ store, timeZone: "UTC" }).handle(get("/auth/me"), later);
    expect(sql.filter((text) => /INSERT INTO account/.test(text))).toEqual([]);
  });

  it("resolves every request to the one owner, for a write and for a read", async () => {
    const identity = localIdentity({ store, timeZone: "UTC" });
    expect(await identity.resolve(get("/api/tasks"))).toEqual({ owner: "local" });
    const read = await identity.resolveRead(get("/api/tasks"), async (owner, s) => ({ owner, same: s === store }));
    expect(read).toEqual({ owner: "local", read: { owner: "local", same: true } });
    expect(identity.describe).toMatch(/device/);
  });

  it("has no sign-in, sign-up, reset, invite or any other route", async () => {
    const identity = localIdentity({ store, timeZone: "UTC" });
    for (const path of [
      "/auth/sign-in", "/auth/sign-up", "/auth/sign-out", "/auth/reset", "/auth/invite", "/auth/invite/accept", "/auth/claim",
      "/auth/password", "/auth/people", "/auth/invites", "/auth/google/start", "/auth/google/callback", "/auth/two-step/setup", "/auth/nothing",
    ]) {
      for (const request of [get(path), post(path)]) {
        const response = await identity.handle(request, later);
        expect(response?.status, path).toBe(404);
      }
    }
    expect((await identity.handle(post("/auth/me"), later))?.status).toBe(404);
  });

  it("leaves everything that is not /auth/ to the app", async () => {
    const identity = localIdentity({ store, timeZone: "UTC" });
    expect(await identity.handle(get("/api/tasks"), later)).toBeNull();
    expect(await identity.handle(get("/"), later)).toBeNull();
  });
});
