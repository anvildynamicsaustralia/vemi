import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { KINDS } from "@vemi/shared";
import { openStore, type Store } from "./store.js";
import { testDb, type TestDb } from "./testing/d1.js";

/**
 * Every tenant read finds its owner's rows through an index.
 *
 * Every account's rows share one table per kind, so a statement that reads by owner and has
 * no owner-led index to use reads every account's rows to find one person's. D1 bills by
 * rows read, and the client reads the tree again after every write. The statements are
 * caught as the store sends them, so this checks the SQL that runs, not a copy of it, and
 * SQLite's own plan says whether a table was walked end to end.
 */

let t: TestDb;
let store: Store;
const sent: { sql: string; binds: unknown[] }[] = [];

beforeAll(async () => {
  t = await testDb();
  // The store's statements, recorded on the way to the real binding.
  const watching = {
    prepare: (sql: string) => ({
      // A statement with nothing to bind (the reminder account list) is read straight off.
      all: () => {
        sent.push({ sql, binds: [] });
        return t.db.prepare(sql).all();
      },
      bind: (...binds: unknown[]) => {
        sent.push({ sql, binds });
        return t.db.prepare(sql).bind(...binds);
      },
    }),
    batch: (statements: D1PreparedStatement[]) => t.db.batch(statements),
  } as unknown as D1Database;
  store = openStore({ DB: watching }, () => new Date("2026-09-14T02:00:00Z"));
});
afterAll(() => t.dispose());

/**
 * The plan's lines that walk a whole table, or the whole of an index that does not start
 * with the owner. Walking a subquery's own result reads only rows already found, and so does
 * a virtual table here: the schema has none of its own (checked below), so the only one a
 * plan can name is `json_each` over one row's own column, a task's steps.
 */
async function walks(sql: string, binds: unknown[]): Promise<string[]> {
  const plan = await t.db.prepare(`EXPLAIN QUERY PLAN ${sql}`).bind(...binds).all<{ detail: string }>();
  return plan.results.map((r) => r.detail)
    .filter((d) => d.startsWith("SCAN ") && !/^SCAN (CONSTANT ROW|\(subquery-\d+\)|\w+ VIRTUAL TABLE INDEX)/.test(d));
}

describe("reads by owner", () => {
  it("never walk a whole table, for the tree, today, search, the archive and every list", async () => {
    const owner = `owner-${crypto.randomUUID()}`;
    sent.length = 0;
    await store.tree(owner);
    await store.today(owner, "2026-09-14");
    await store.search(owner, "anything");
    await store.archived(owner);
    for (const kind of KINDS) await store.list(owner, kind, {});
    expect(sent.length).toBeGreaterThan(KINDS.length);

    const found: string[] = [];
    for (const { sql, binds } of sent) {
      for (const line of await walks(sql, binds)) found.push(`${line}  <-  ${sql.replace(/\s+/g, " ").slice(0, 120)}`);
    }
    expect(found).toEqual([]);
  });

  it("never walk a whole table for the per-minute reminder scan or the sign-in throttle", async () => {
    const owner = `owner-${crypto.randomUUID()}`;
    sent.length = 0;
    await store.reminderAccounts();
    await store.dueReminders(owner, "2026-09-14T09:00", "2026-09-14T09:01", 50);
    await store.attempt(null, [{ key: "k", limit: 5 }], "2026-09-14T02:00:00.000Z", "2026-09-14T01:00:00.000Z", "2026-09-14T00:00:00.000Z");
    expect(sent.length).toBeGreaterThanOrEqual(3);
    const found: string[] = [];
    for (const { sql, binds } of sent) {
      for (const line of await walks(sql, binds)) found.push(`${line}  <-  ${sql.replace(/\s+/g, " ").slice(0, 120)}`);
    }
    // Allowed: reminderAccounts reads every account that turned reminders on, by design, and
    // `SCAN k` is the throttle insert reading its own one-row VALUES list, not a table.
    expect(found.filter((l) => !/FROM account a/.test(l) && !/^SCAN a\b/.test(l) && !/^SCAN k\b/.test(l))).toEqual([]);
  });

  it("have no virtual table in the schema, so a virtual table in a plan is a row's own JSON", async () => {
    const virtual = await t.db.prepare(`SELECT name FROM sqlite_master WHERE sql LIKE 'CREATE VIRTUAL TABLE%'`).all();
    expect(virtual.results).toEqual([]);
  });
});
