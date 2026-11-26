import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hashPassword } from "./password.js";
import { openStore, type Outcome, type Store } from "./store.js";
import { migrationStatements, testDb, type TestDb } from "./testing/d1.js";
import { parseCreate, parsePatch } from "./validate.js";

/**
 * 0017_task_remind_repeat: a task's reminder and repeat. Every assertion maps to a line of
 * the phase's Done: both fields round-trip through create, patch, the tree and today; null
 * clears; bad values are refused; two accounts never see each other's; and the file can be
 * run twice with no change.
 */

type Row = Record<string, unknown>;
const T = "2026-01-01T00:00:00.000Z";
const PASSWORD = "a long enough password";
const NOW = new Date("2026-11-17T02:00:00Z");

function must<V>(outcome: Outcome<V>): V {
  if (!outcome.ok) throw new Error(`${outcome.status}: ${outcome.error}`);
  return outcome.value;
}

describe("0017_task_remind_repeat over a database holding 0001 to 0016", () => {
  let old: TestDb;
  const go = (sql: string, ...binds: unknown[]) => old.db.prepare(sql).bind(...binds).run();
  const all = async (sql: string): Promise<Row[]> => (await old.db.prepare(sql).all<Row>()).results;
  const apply = async (again: boolean) => {
    for (const sql of migrationStatements((f) => f.startsWith("0017_"))) {
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
    old = await testDb({ through: "0016_map_home.sql" });
    await go(`INSERT INTO tenant (id, created_at) VALUES ('o', ?)`, T);
    await go(`INSERT INTO venture (id, owner, name, created_at, updated_at) VALUES ('v', 'o', 'V', ?, ?)`, T, T);
    await go(`INSERT INTO task (id, owner, venture_id, title, position, created_at, updated_at) VALUES ('t', 'o', 'v', 'Old', 1, ?, ?)`, T, T);
    await apply(false);
  });
  afterAll(() => old.dispose());

  it("adds both columns, empty, to an existing task", async () => {
    expect((await all(`SELECT remind_at, repeat FROM task`))[0]).toEqual({ remind_at: null, repeat: null });
  });

  it("changes nothing when the file is applied a second time", async () => {
    await go(`UPDATE task SET remind_at = '2026-11-17T09:00', repeat = 'day'`);
    const before = await all(`SELECT * FROM task`);
    await apply(true);
    expect(await all(`SELECT * FROM task`)).toEqual(before);
  });
});

describe("a task's reminder and repeat through the store", () => {
  let t: TestDb;
  let store: Store;
  let passwordHash: string;

  beforeAll(async () => {
    t = await testDb();
    store = openStore({ DB: t.db }, () => NOW);
    passwordHash = await hashPassword(PASSWORD);
  });
  afterAll(() => t.dispose());

  async function account(): Promise<{ owner: string; venture: string }> {
    const owner = `owner-${crypto.randomUUID()}`;
    expect(await store.createAccount({ id: owner, email: `${owner}@example.test`, passwordHash, googleSub: null, confirmed: true })).toBe(true);
    const venture = must(await store.create(owner, "ventures", { id: crypto.randomUUID(), name: "Space" })).record.id;
    return { owner, venture };
  }
  const create = (body: unknown) => {
    const parsed = parseCreate("tasks", body);
    if (!parsed.ok) throw new Error(parsed.error);
    return parsed.value;
  };
  const patch = (body: unknown) => {
    const parsed = parsePatch("tasks", body);
    if (!parsed.ok) throw new Error(parsed.error);
    return parsed.value;
  };

  it("defaults both fields to null", async () => {
    const a = await account();
    const id = `task-${crypto.randomUUID()}`;
    const task = must(await store.create(a.owner, "tasks", create({ id: id, ventureId: a.venture, title: "Plain" }))).record;
    expect(task.remindAt).toBeNull();
    expect(task.repeat).toBeNull();
  });

  it("takes both on create and returns them from get, the tree and today", async () => {
    const a = await account();
    const id = `task-${crypto.randomUUID()}`;
    const made = must(await store.create(a.owner, "tasks", create({
      id: id, ventureId: a.venture, title: "Both", pickedOn: "2026-11-17", remindAt: "2026-11-17T09:00", repeat: "week:2",
    }))).record;
    expect(made.remindAt).toBe("2026-11-17T09:00");
    expect(made.repeat).toBe("week:2");
    const got = await store.get(a.owner, "tasks", id);
    expect([got?.remindAt, got?.repeat]).toEqual(["2026-11-17T09:00", "week:2"]);
    const inTree = (await store.tree(a.owner)).ventures[0]!.tasks.find((x) => x.id === id);
    expect([inTree?.remindAt, inTree?.repeat]).toEqual(["2026-11-17T09:00", "week:2"]);
    const today = (await store.today(a.owner, "2026-11-17")).tasks.find((x) => x.id === id);
    expect([today?.remindAt, today?.repeat]).toEqual(["2026-11-17T09:00", "week:2"]);
  });

  it("sets by patch, keeps them when other fields change, and clears each with null", async () => {
    const a = await account();
    const id = `task-${crypto.randomUUID()}`;
    must(await store.create(a.owner, "tasks", create({ id: id, ventureId: a.venture, title: "Later" })));
    const set = must(await store.update(a.owner, "tasks", id, patch({ remindAt: "2026-12-01T17:30", repeat: "weekday" }))).record;
    expect([set.remindAt, set.repeat]).toEqual(["2026-12-01T17:30", "weekday"]);
    const renamed = must(await store.update(a.owner, "tasks", id, patch({ title: "Renamed" }))).record;
    expect([renamed.remindAt, renamed.repeat]).toEqual(["2026-12-01T17:30", "weekday"]);
    const noRemind = must(await store.update(a.owner, "tasks", id, patch({ remindAt: null }))).record;
    expect([noRemind.remindAt, noRemind.repeat]).toEqual([null, "weekday"]);
    const none = must(await store.update(a.owner, "tasks", id, patch({ repeat: null }))).record;
    expect([none.remindAt, none.repeat]).toEqual([null, null]);
  });

  it("refuses a remindAt that is not YYYY-MM-DDTHH:MM", () => {
    const bad = [
      "2026-11-17", "2026-11-17T09:00:00", "2026-11-17 09:00", "2026-11-17T9:00", "2026-11-17T24:00", "2026-11-17T09:60",
      "2026-02-30T09:00", "2026-11-17T09:00Z", "tomorrow", "", 900, true,
    ];
    for (const v of bad) {
      expect(parsePatch("tasks", { remindAt: v }).ok, `patch ${String(v)}`).toBe(false);
      expect(parseCreate("tasks", { ventureId: "v", title: "x", remindAt: v }).ok, `create ${String(v)}`).toBe(false);
    }
    expect(parsePatch("tasks", { remindAt: "2026-11-17T23:59" }).ok).toBe(true);
    expect(parsePatch("tasks", { remindAt: null }).ok).toBe(true);
  });

  it("refuses a repeat outside the grammar", () => {
    for (const v of ["daily", "Day", "week", "week:0", "week:8", "week:1.5", "year", "", 1, true]) {
      expect(parsePatch("tasks", { repeat: v }).ok, `patch ${String(v)}`).toBe(false);
      expect(parseCreate("tasks", { ventureId: "v", title: "x", repeat: v }).ok, `create ${String(v)}`).toBe(false);
    }
    for (const v of ["day", "weekday", "month", "week:1", "week:7", null]) {
      expect(parsePatch("tasks", { repeat: v }).ok, String(v)).toBe(true);
    }
  });

  it("keeps one account's reminder and repeat from another's", async () => {
    const a = await account();
    const id = `task-${crypto.randomUUID()}`;
    const b = await account();
    must(await store.create(a.owner, "tasks", create({
      id: id, ventureId: a.venture, title: "Mine", pickedOn: "2026-11-17", remindAt: "2026-11-17T09:00", repeat: "day",
    })));
    expect(await store.get(b.owner, "tasks", id)).toBeNull();
    const refused = await store.update(b.owner, "tasks", id, patch({ remindAt: null, repeat: null }));
    expect(refused.ok).toBe(false);
    expect((await store.today(b.owner, "2026-11-17")).tasks).toEqual([]);
    expect((await store.tree(b.owner)).ventures[0]!.tasks).toEqual([]);
    const mine = await store.get(a.owner, "tasks", id);
    expect([mine?.remindAt, mine?.repeat]).toEqual(["2026-11-17T09:00", "day"]);
  });
});
