import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_APPEARANCE } from "@vemi/shared";
import { createApp, type App } from "./app.js";
import { accountIdentity } from "./accountIdentity.js";
import { hashPassword } from "./password.js";
import { openStore, type Outcome, type Store } from "./store.js";
import { migrationStatements, testDb, type TestDb } from "./testing/d1.js";
import { parseAppearance } from "./validate.js";
import { PROFILE_DEFAULTS } from "./testing/profileDefaults.js";

/**
 * 0019_capture_settings: the space new tasks go to and the date of the last weekly review.
 * Every assertion maps to a line of the phase's Done: both columns arrive empty, the file runs
 * twice with no change, the appearance routes carry both values, a space the caller does not
 * own is refused, and two accounts never see each other's.
 */

type Row = Record<string, unknown>;
const T = "2026-01-01T00:00:00.000Z";
const ORIGIN = "https://vemi.example.workers.dev";
const PASSWORD = "a long enough password";

function must<V>(outcome: Outcome<V>): V {
  if (!outcome.ok) throw new Error(`${outcome.status}: ${outcome.error}`);
  return outcome.value;
}

describe("0019_capture_settings over a database holding 0001 to 0018", () => {
  let old: TestDb;
  const go = (sql: string, ...binds: unknown[]) => old.db.prepare(sql).bind(...binds).run();
  const all = async (sql: string): Promise<Row[]> => (await old.db.prepare(sql).all<Row>()).results;
  const apply = async (again: boolean) => {
    for (const sql of migrationStatements((f) => f.startsWith("0019_"))) {
      try {
        await old.db.prepare(sql).run();
      } catch (e) {
        // SQLite has no ADD COLUMN IF NOT EXISTS. The runner never applies a file twice; the
        // only statements allowed to refuse on a second pass are the two columns.
        if (!(again && e instanceof Error && e.message.includes("duplicate column name"))) throw e;
      }
    }
  };

  beforeAll(async () => {
    old = await testDb({ through: "0018_project_brief.sql" });
    await go(`INSERT INTO tenant (id, created_at) VALUES ('o', ?)`, T);
    await go(`INSERT INTO account (id, email, password_hash, created_at, updated_at) VALUES ('o', 'o@example.test', 'x', ?, ?)`, T, T);
    await go(`INSERT INTO venture (id, owner, name, created_at, updated_at) VALUES ('v', 'o', 'V', ?, ?)`, T, T);
    await apply(false);
  });
  afterAll(() => old.dispose());

  it("adds both columns, empty, to an existing account", async () => {
    expect((await all(`SELECT new_task_venture_id, last_review_on FROM account`))[0])
      .toEqual({ new_task_venture_id: null, last_review_on: null });
  });

  it("changes nothing when the file is applied a second time", async () => {
    await go(`UPDATE account SET new_task_venture_id = 'v', last_review_on = '2026-11-14'`);
    const before = await all(`SELECT * FROM account`);
    await apply(true);
    expect(await all(`SELECT * FROM account`)).toEqual(before);
  });
});

describe("capture settings through the store and the routes", () => {
  let t: TestDb;
  let store: Store;
  let app: App;
  let passwordHash: string;
  const NOW = new Date("2026-11-17T02:00:00Z");
  const EMPTY = {
    ...DEFAULT_APPEARANCE, newTaskVentureId: null, lastReviewOn: null,
    morningAt: null, taskReminders: false, quietFrom: null, quietTo: null, ...PROFILE_DEFAULTS,
  };

  beforeAll(async () => {
    t = await testDb();
    store = openStore({ DB: t.db }, () => NOW);
    passwordHash = await hashPassword(PASSWORD);
    const clock = () => NOW;
    app = createApp({
      store, now: clock, origin: ORIGIN, timeZone: "Australia/Sydney",
      identity: accountIdentity({
        store, now: clock, origin: ORIGIN, owner: "the-operator", operatorEmail: "", sessionSecret: "session-secret",
        google: null, fetch: async () => { throw new Error("a test reached the network"); },
      }),
      live: { publish: async () => {}, connect: async () => new Response("connected") },
    });
  });
  afterAll(() => t.dispose());

  async function account(): Promise<{ owner: string; venture: string }> {
    const owner = `owner-${crypto.randomUUID()}`;
    expect(await store.createAccount({ id: owner, email: `${owner}@example.test`, passwordHash, googleSub: null, confirmed: true })).toBe(true);
    const venture = must(await store.create(owner, "ventures", { id: crypto.randomUUID(), name: "Space" })).record.id;
    return { owner, venture };
  }

  async function signIn(owner: string): Promise<string> {
    const res = await app(new Request(`${ORIGIN}/auth/sign-in`, {
      method: "POST", headers: { origin: ORIGIN, "content-type": "application/json" },
      body: JSON.stringify({ email: `${owner}@example.test`, password: PASSWORD }),
    }), () => {});
    expect(res.status).toBe(200);
    return (res.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  }

  const call = (cookie: string, method: string, body?: unknown) => app(new Request(`${ORIGIN}/api/appearance`, {
    method, headers: { origin: ORIGIN, cookie, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  }), () => {});

  it("starts both empty, keeps them with the look, and clears each with null", async () => {
    const a = await account();
    expect(await store.appearance(a.owner)).toEqual(EMPTY);
    const saved = must(await store.setAppearance(a.owner, { newTaskVentureId: a.venture, lastReviewOn: "2026-11-14" }));
    expect(saved).toEqual({ ...EMPTY, newTaskVentureId: a.venture, lastReviewOn: "2026-11-14" });
    expect(await store.appearance(a.owner)).toEqual(saved);
    // A look change leaves the capture settings alone.
    expect(must(await store.setAppearance(a.owner, { theme: "dark" }))).toEqual({ ...saved, theme: "dark" });
    expect(must(await store.setAppearance(a.owner, { newTaskVentureId: null, lastReviewOn: null }))).toEqual({ ...EMPTY, theme: "dark" });
  });

  it("refuses a space the account does not own, and changes nothing", async () => {
    const a = await account();
    const b = await account();
    expect(await store.setAppearance(b.owner, { newTaskVentureId: a.venture, lastReviewOn: "2026-11-14" }))
      .toMatchObject({ ok: false, status: 404 });
    expect(await store.appearance(b.owner)).toEqual(EMPTY);
    expect(await store.setAppearance(b.owner, { newTaskVentureId: "no-such-space" })).toMatchObject({ ok: false, status: 404 });
  });

  it("reports an account that does not exist as 404", async () => {
    expect(await store.setAppearance("nobody", { lastReviewOn: "2026-11-14" })).toMatchObject({ ok: false, status: 404 });
  });

  it("takes the two keys on a patch and refuses a bad value", () => {
    expect(parseAppearance({ newTaskVentureId: "v1" })).toEqual({ ok: true, value: { newTaskVentureId: "v1" } });
    expect(parseAppearance({ newTaskVentureId: null, lastReviewOn: null })).toEqual({ ok: true, value: { newTaskVentureId: null, lastReviewOn: null } });
    expect(parseAppearance({ lastReviewOn: "2026-11-14" })).toEqual({ ok: true, value: { lastReviewOn: "2026-11-14" } });
    for (const bad of [
      { newTaskVentureId: "" }, { newTaskVentureId: 4 }, { newTaskVentureId: {} },
      { lastReviewOn: "2026-02-30" }, { lastReviewOn: "14/11/2026" }, { lastReviewOn: 20261114 }, { lastReviewOn: "" },
    ]) expect(parseAppearance(bad).ok, JSON.stringify(bad)).toBe(false);
  });

  it("answers GET and PATCH on /api/appearance with both values, for the caller only", async () => {
    const a = await account();
    const b = await account();
    const ca = await signIn(a.owner);
    const cb = await signIn(b.owner);

    expect(await (await call(ca, "GET")).json()).toEqual(EMPTY);
    const patched = await call(ca, "PATCH", { newTaskVentureId: a.venture, lastReviewOn: "2026-11-14" });
    expect(patched.status).toBe(200);
    const expected = { ...EMPTY, newTaskVentureId: a.venture, lastReviewOn: "2026-11-14" };
    expect(await patched.json()).toEqual(expected);
    expect(await (await call(ca, "GET")).json()).toEqual(expected);
    expect(await (await call(cb, "GET")).json()).toEqual(EMPTY);

    // Someone else's space is refused, and a bad date is a 400 before the store is asked.
    expect((await call(cb, "PATCH", { newTaskVentureId: a.venture })).status).toBe(404);
    expect((await call(ca, "PATCH", { lastReviewOn: "tomorrow" })).status).toBe(400);
    expect((await call(ca, "PATCH", { newTaskVentureId: null })).status).toBe(200);
    expect(await (await call(ca, "GET")).json()).toEqual({ ...expected, newTaskVentureId: null });
    expect((await call("", "GET")).status).toBe(401);
  });
});
