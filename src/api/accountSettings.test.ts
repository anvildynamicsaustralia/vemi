import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_NEW_STAGES } from "@vemi/shared";
import { createApp, type App } from "./app.js";
import { accountIdentity } from "./accountIdentity.js";
import { hashPassword } from "./password.js";
import { openStore, type Outcome, type Store } from "./store.js";
import { migrationStatements, testDb, type TestDb } from "./testing/d1.js";
import { parseAppearance } from "./validate.js";

/**
 * 0023_account_settings: the four level names, the stages a new space starts with, the first
 * screen, the Extras and the time zone on the account, and the views and monogram on a space.
 * Each assertion maps to a line of the phase's Done: the columns arrive empty, the appearance
 * routes carry them strictly, a new space starts with the account's stages and an old one is
 * left alone, the connector reads the grant owner's own words and zone, and nobody sees
 * another account's.
 */

type Row = Record<string, unknown>;
const T = "2026-01-01T00:00:00.000Z";
const ORIGIN = "https://vemi.example.workers.dev";
const PASSWORD = "a long enough password";
const NOW = new Date("2026-11-17T02:00:00Z");

function must<V>(outcome: Outcome<V>): V {
  if (!outcome.ok) throw new Error(`${outcome.status}: ${outcome.error}`);
  return outcome.value;
}

describe("0023_account_settings over a database holding 0001 to 0022", () => {
  let old: TestDb;
  const go = (sql: string, ...binds: unknown[]) => old.db.prepare(sql).bind(...binds).run();
  const all = async (sql: string): Promise<Row[]> => (await old.db.prepare(sql).all<Row>()).results;

  beforeAll(async () => {
    old = await testDb({ through: "0022_connector.sql" });
    await go(`INSERT INTO tenant (id, created_at) VALUES ('o', ?)`, T);
    await go(`INSERT INTO account (id, email, password_hash, created_at, updated_at) VALUES ('o', 'o@example.test', 'x', ?, ?)`, T, T);
    await go(`INSERT INTO venture (id, owner, name, created_at, updated_at) VALUES ('v', 'o', 'V', ?, ?)`, T, T);
    for (const sql of migrationStatements((f) => f.startsWith("0023_"))) await old.db.prepare(sql).run();
  });
  afterAll(() => old.dispose());

  it("adds the account columns, all empty or at the shipped value, to an existing account", async () => {
    expect((await all(`SELECT level_space, level_project, level_milestone, level_task, default_stages, start_on, extras, time_zone FROM account`))[0])
      .toEqual({
        level_space: null, level_project: null, level_milestone: null, level_task: null,
        default_stages: null, start_on: "map", extras: "{}", time_zone: null,
      });
  });

  it("adds both space columns to an existing space, with both views on", async () => {
    expect((await all(`SELECT views, monogram FROM venture`))[0]).toEqual({ views: '["board","projects"]', monogram: null });
  });

  it("refuses a first screen that is neither map nor today", async () => {
    await expect(go(`UPDATE account SET start_on = 'inbox'`)).rejects.toThrow();
  });
});

describe("account settings through the store and the routes", () => {
  let t: TestDb;
  let store: Store;
  let app: App;
  let passwordHash: string;

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

  async function account(): Promise<string> {
    const owner = `owner-${crypto.randomUUID()}`;
    expect(await store.createAccount({ id: owner, email: `${owner}@example.test`, passwordHash, googleSub: null, confirmed: true })).toBe(true);
    return owner;
  }

  async function signIn(owner: string): Promise<string> {
    const res = await app(new Request(`${ORIGIN}/auth/sign-in`, {
      method: "POST", headers: { origin: ORIGIN, "content-type": "application/json" },
      body: JSON.stringify({ email: `${owner}@example.test`, password: PASSWORD }),
    }), () => {});
    expect(res.status).toBe(200);
    return (res.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  }

  const call = (cookie: string, path: string, method: string, body?: unknown) => app(new Request(`${ORIGIN}/api/${path}`, {
    method, headers: { origin: ORIGIN, cookie, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  }), () => {});

  const stagesOf = async (owner: string, ventureId: string) =>
    (await t.db.prepare(`SELECT name, kind, position FROM stage WHERE venture_id = ? AND owner = ? ORDER BY position`)
      .bind(ventureId, owner).all<{ name: string; kind: string; position: number }>()).results;

  it("starts at the shipped words, five stages, the map, every Extra on and no zone", async () => {
    const owner = await account();
    expect(await store.appearance(owner)).toMatchObject({
      levelNames: { space: "Space", project: "Project", milestone: "Milestone", task: "Task" },
      defaultStages: null, startOn: "map", timeZone: null,
      extras: { smartDates: true, singleKeys: true, recent: true, rings: true, comingUp: true, burst: true },
    });
  });

  it("keeps each setting, merges a level name or an Extra sent alone, and puts a name back with null", async () => {
    const owner = await account();
    const saved = must(await store.setAppearance(owner, {
      levelNames: { space: "Studio", task: "Step" }, startOn: "today", timeZone: "Pacific/Honolulu",
      extras: { rings: false }, defaultStages: [{ name: "Draft", kind: "early" }, { name: "Out", kind: "shipped" }],
    }));
    expect(saved.levelNames).toEqual({ space: "Studio", project: "Project", milestone: "Milestone", task: "Step" });
    expect(await store.appearance(owner)).toEqual(saved);
    const more = must(await store.setAppearance(owner, { levelNames: { project: "Job" }, extras: { burst: false } }));
    expect(more.levelNames).toEqual({ space: "Studio", project: "Job", milestone: "Milestone", task: "Step" });
    expect(more.extras).toMatchObject({ rings: false, burst: false, recent: true });
    const back = must(await store.setAppearance(owner, { levelNames: { space: null }, defaultStages: null, timeZone: null }));
    expect(back.levelNames.space).toBe("Space");
    expect(back.defaultStages).toBeNull();
    expect(back.timeZone).toBeNull();
    expect(back.startOn).toBe("today");
  });

  it("never lets one account see or change another's", async () => {
    const a = await account();
    const b = await account();
    must(await store.setAppearance(a, { levelNames: { space: "Studio" }, timeZone: "Pacific/Honolulu", startOn: "today", extras: { rings: false } }));
    expect(await store.appearance(b)).toMatchObject({
      levelNames: { space: "Space" }, timeZone: null, startOn: "map", extras: { rings: true },
    });
    const cookie = await signIn(b);
    const read = await (await call(cookie, "appearance", "GET")).json() as { levelNames: { space: string } };
    expect(read.levelNames.space).toBe("Space");
  });

  it("reads and writes them over /api/appearance, and refuses what it does not know", async () => {
    const owner = await account();
    const cookie = await signIn(owner);
    const res = await call(cookie, "appearance", "PATCH", {
      levelNames: { milestone: "Checkpoint" }, startOn: "today", extras: { comingUp: false }, timeZone: "Australia/Perth",
      defaultStages: [{ name: "Plan", kind: "early" }],
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      levelNames: { milestone: "Checkpoint", space: "Space" }, startOn: "today", timeZone: "Australia/Perth",
      extras: { comingUp: false, rings: true }, defaultStages: [{ name: "Plan", kind: "early" }],
    });
    expect(await (await call(cookie, "appearance", "GET")).json()).toMatchObject({ levelNames: { milestone: "Checkpoint" } });
  });

  it("refuses a misspelt or malformed setting with a 400 and changes nothing", async () => {
    const owner = await account();
    const cookie = await signIn(owner);
    const bad: unknown[] = [
      { levelNames: { venture: "Studio" } }, { levelNames: {} }, { levelNames: { space: "" } }, { levelNames: { space: 4 } },
      { levelNames: { space: "x".repeat(31) } }, { levelNames: "Studio" },
      { defaultStages: [] }, { defaultStages: [{ name: "A", kind: "colour" }] }, { defaultStages: [{ name: "A", kind: "early", extra: 1 }] },
      { defaultStages: "Idea" }, { defaultStages: Array.from({ length: 21 }, (_, n) => ({ name: `S${n}`, kind: "early" })) },
      { startOn: "inbox" }, { startOn: null },
      { extras: { glitter: true } }, { extras: { rings: "yes" } }, { extras: {} }, { extras: [] },
      { timeZone: "Mars/Olympus" }, { timeZone: 5 },
      { levelname: { space: "Studio" } },
    ];
    for (const body of bad) {
      expect(parseAppearance(body).ok, JSON.stringify(body)).toBe(false);
      expect((await call(cookie, "appearance", "PATCH", body)).status, JSON.stringify(body)).toBe(400);
    }
    expect(await store.appearance(owner)).toMatchObject({ levelNames: { space: "Space" }, startOn: "map", timeZone: null });
  });

  it("gives a new space Idea, Building, Live, Paused and Stopped when the account has chosen nothing", async () => {
    const owner = await account();
    const space = must(await store.create(owner, "ventures", { name: "Fresh" })).record.id;
    expect(await stagesOf(owner, space)).toEqual(DEFAULT_NEW_STAGES.map((s, n) => ({ name: s.name, kind: s.kind, position: n + 1 })));
    expect(DEFAULT_NEW_STAGES.map((s) => s.name)).toEqual(["Idea", "Building", "Live", "Paused", "Stopped"]);
  });

  it("gives a new space the account's own stages, and leaves the spaces that exist alone", async () => {
    const owner = await account();
    const old = must(await store.create(owner, "ventures", { name: "Old" })).record.id;
    must(await store.setAppearance(owner, { defaultStages: [{ name: "Sketch", kind: "early" }, { name: "Ship", kind: "shipped" }] }));
    const fresh = must(await store.create(owner, "ventures", { name: "New" })).record.id;
    expect(await stagesOf(owner, fresh)).toEqual([{ name: "Sketch", kind: "early", position: 1 }, { name: "Ship", kind: "shipped", position: 2 }]);
    expect((await stagesOf(owner, old)).map((s) => s.name)).toEqual(["Idea", "Building", "Live", "Paused", "Stopped"]);
    // Another account's choice never reaches this one.
    const other = await account();
    const theirs = must(await store.create(other, "ventures", { name: "Theirs" })).record.id;
    expect((await stagesOf(other, theirs)).map((s) => s.name)).toEqual(["Idea", "Building", "Live", "Paused", "Stopped"]);
  });

  it("keeps a space's views and monogram, refuses none on and an unknown view, and clears the monogram with blank", async () => {
    const owner = await account();
    const space = must(await store.create(owner, "ventures", { name: "Workshop" })).record;
    expect(space).toMatchObject({ views: ["board", "projects"], monogram: null });
    const cookie = await signIn(owner);
    const patch = (body: unknown) => call(cookie, `ventures/${space.id}`, "PATCH", body);
    expect((await patch({ views: ["projects"], monogram: "WK" })).status).toBe(200);
    expect(await store.get(owner, "ventures", space.id)).toMatchObject({ views: ["projects"], monogram: "WK" });
    for (const body of [{ views: [] }, { views: ["list"] }, { views: ["board", "board"] }, { views: "board" }, { monogram: "ABCD" }]) {
      expect((await patch(body)).status, JSON.stringify(body)).toBe(400);
    }
    expect((await patch({ monogram: "" })).status).toBe(200);
    expect(await store.get(owner, "ventures", space.id)).toMatchObject({ views: ["projects"], monogram: null });
  });

  it("reads today in the account's zone when the request names none, and in ?tz= when it does", async () => {
    const owner = await account();
    const cookie = await signIn(owner);
    // 02:00 UTC on the 17th is the 17th in Sydney and the 16th in Honolulu.
    const day = async (path: string) => ((await (await call(cookie, path, "GET")).json()) as { on: string }).on;
    expect(await day("today")).toBe("2026-11-17");
    must(await store.setAppearance(owner, { timeZone: "Pacific/Honolulu" }));
    expect(await day("today")).toBe("2026-11-16");
    expect(await day("today?tz=Australia/Sydney")).toBe("2026-11-17");
    const file = await call(cookie, "export", "GET");
    expect(file.headers.get("content-disposition")).toContain("vemi-export-2026-11-16.json");
  });

  it("hands the reminders job the account's zone ahead of a device's", async () => {
    const owner = await account();
    must(await store.setAppearance(owner, { taskReminders: true }));
    await store.subscribePush(owner, {
      endpoint: "https://push.example/abc", p256dh: "p", auth: "a", label: null, tz: "Australia/Sydney",
    });
    expect((await store.reminderAccounts()).find((r) => r.owner === owner)?.tz).toBe("Australia/Sydney");
    must(await store.setAppearance(owner, { timeZone: "Pacific/Honolulu" }));
    expect((await store.reminderAccounts()).find((r) => r.owner === owner)?.tz).toBe("Pacific/Honolulu");
  });
});
