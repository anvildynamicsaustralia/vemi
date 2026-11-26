import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import {
  compareCounts,
  countQuery,
  countsFromRows,
  dropEverything,
  inRestoreOrder,
  parseMigrationsList,
  LEFT_OUT_OF_STAGING,
  moveInSql,
  notEmptyRefusal,
  pendingMigrations,
  stagingGateMessage,
  TABLE_LIST_SQL,
  tablesInDump,
  withoutTables,
} from "./stagingSql.mjs";

/**
 * The pure half of staging's scripts: text in, text out, no D1 binding and no
 * subprocess. Every case here is checked against a real shape — a dump built the way
 * `wrangler d1 export` builds one, and a `wrangler d1 migrations list` transcript
 * captured live against a local database.
 */

describe("withoutTables", () => {
  const dump = [
    `-- VEMI-003 database dump, 2026-09-27T00:00:00.000Z`,
    ``,
    `CREATE TABLE venture (id TEXT PRIMARY KEY);`,
    `INSERT INTO "venture" ("id") VALUES ('v1');`,
    ``,
    `CREATE TABLE credential (id TEXT PRIMARY KEY);`,
    `INSERT INTO "credential" ("id") VALUES ('c1');`,
    `INSERT INTO "credential" ("id") VALUES ('c2');`,
    ``,
    `CREATE TABLE recovery_code (id TEXT PRIMARY KEY);`,
    `INSERT INTO "recovery_code" ("id") VALUES ('r1');`,
    ``,
  ].join("\n");

  it("drops every INSERT for the named tables and leaves the rest", () => {
    const out = withoutTables(dump, LEFT_OUT_OF_STAGING);
    expect(out).toContain(`CREATE TABLE credential (id TEXT PRIMARY KEY);`);
    expect(out).toContain(`INSERT INTO "venture" ("id") VALUES ('v1');`);
    expect(out).not.toContain(`INSERT INTO "credential"`);
    expect(out).not.toContain(`INSERT INTO "recovery_code"`);
  });

  it("leaves schema statements alone when no table is dropped", () => {
    expect(withoutTables(dump, [])).toBe(dump);
  });

  it("touches nothing when the named table has no rows in the dump", () => {
    expect(withoutTables(dump, ["challenge"])).toBe(dump);
  });
});

describe("LEFT_OUT_OF_STAGING", () => {
  it("is credential, recovery_code, challenge, email_token, throttle", () => {
    expect(LEFT_OUT_OF_STAGING).toEqual(["credential", "recovery_code", "challenge", "email_token", "throttle"]);
  });

  it("copies account, so the production password signs in on staging", () => {
    expect(LEFT_OUT_OF_STAGING).not.toContain("account");
    const dump = [`CREATE TABLE account (id TEXT PRIMARY KEY);`, `INSERT INTO "account" ("id") VALUES ('a1');`].join("\n");
    expect(withoutTables(dump, LEFT_OUT_OF_STAGING)).toBe(dump);
  });

  it("drops the mail token and throttle rows", () => {
    const dump = [`INSERT INTO "email_token" ("id") VALUES ('e1');`, `INSERT INTO "throttle" ("id") VALUES ('t1');`].join("\n");
    expect(withoutTables(dump, LEFT_OUT_OF_STAGING)).toBe("");
  });
});

describe("dropEverything", () => {
  it("defers foreign keys, drops every named table, and drops d1_migrations too", () => {
    expect(dropEverything(["venture", "task"])).toBe(
      [
        `PRAGMA defer_foreign_keys = on;`,
        `DROP TABLE IF EXISTS "venture";`,
        `DROP TABLE IF EXISTS "task";`,
        `DROP TABLE IF EXISTS "d1_migrations";`,
      ].join("\n"),
    );
  });

  it("still drops d1_migrations when given no table names", () => {
    expect(dropEverything([])).toBe(
      [`PRAGMA defer_foreign_keys = on;`, `DROP TABLE IF EXISTS "d1_migrations";`].join("\n"),
    );
  });
});

describe("countQuery", () => {
  it("counts every table in one row, one scalar subquery per table", () => {
    expect(countQuery(["venture", "task"])).toBe(
      `SELECT (SELECT COUNT(*) FROM "venture") AS "venture", (SELECT COUNT(*) FROM "task") AS "task";`,
    );
  });

  // D1 refuses a compound SELECT past a handful of terms ("too many terms in compound
  // SELECT", 2026-09-27, against production's seventeen tables), so the query has none.
  it("carries no compound SELECT, and runs over seventeen tables", () => {
    const names = Array.from({ length: 17 }, (_, i) => `t${i}`);
    const sql = countQuery(names);
    expect(sql).not.toMatch(/\bUNION\b/i);
    const db = new DatabaseSync(":memory:");
    for (const name of names) db.exec(`CREATE TABLE "${name}" (id INTEGER)`);
    db.exec(`INSERT INTO "t3" VALUES (1), (2)`);
    const row = db.prepare(sql).get() as Record<string, unknown>;
    expect(countsFromRows([row])).toEqual({ ...Object.fromEntries(names.map((n) => [n, 0])), t3: 2 });
  });
});

describe("countsFromRows", () => {
  it("reads the one row countQuery returns as table → count", () => {
    expect(countsFromRows([{ venture: 3, task: "5" }])).toEqual({ venture: 3, task: 5 });
  });

  it("reads nothing from no rows", () => {
    expect(countsFromRows([])).toEqual({});
  });
});

describe("compareCounts", () => {
  it("finds nothing wrong when every count matches", () => {
    const expected = { venture: 3, task: 5 };
    const actual = { venture: 3, task: 5 };
    expect(compareCounts(expected, actual, [])).toEqual([]);
  });

  it("reports every table whose count does not match", () => {
    const expected = { venture: 3, task: 5, credential: 2 };
    const actual = { venture: 3, task: 4, credential: 0 };
    expect(compareCounts(expected, actual, [])).toEqual([
      "task: expected 5, found 4",
      "credential: expected 2, found 0",
    ]);
  });

  it("skips the tables named in skip even when they mismatch", () => {
    const expected = { venture: 3, credential: 2 };
    const actual = { venture: 3, credential: 0 };
    expect(compareCounts(expected, actual, ["credential"])).toEqual([]);
  });

  it("treats a table missing from actual as a count of zero", () => {
    expect(compareCounts({ venture: 1 }, {}, [])).toEqual(["venture: expected 1, found 0"]);
  });
});

describe("pendingMigrations", () => {
  it("keeps only the local files not yet applied, in local order", () => {
    const local = ["0001_foundation.sql", "0002_board.sql", "0003_parked.sql"];
    const applied = ["0001_foundation.sql"];
    expect(pendingMigrations(local, applied)).toEqual(["0002_board.sql", "0003_parked.sql"]);
  });

  it("is empty once every local file is applied", () => {
    const local = ["0001_foundation.sql"];
    expect(pendingMigrations(local, local)).toEqual([]);
  });
});

describe("parseMigrationsList", () => {
  // Captured live against a local database, 2026-09-27, `wrangler d1 migrations list DB
  // --local --persist-to <tmp>`.
  const pending = [
    `Migrations to be applied:`,
    `┌─────────────────────┐`,
    `│ Name                │`,
    `├─────────────────────┤`,
    `│ 0001_foundation.sql │`,
    `├─────────────────────┤`,
    `│ 0002_board.sql      │`,
    `├─────────────────────┤`,
    `│ 0003_parked.sql     │`,
    `├─────────────────────┤`,
    `│ 0004_map.sql        │`,
    `├─────────────────────┤`,
    `│ 0005_tags.sql       │`,
    `└─────────────────────┘`,
  ].join("\n");

  // Captured the same way, after applying every migration.
  const none = [
    ` ⛅️ wrangler 4.131.1 (update available 4.141.0)`,
    `───────────────────────────────────────────────`,
    `Resource location: local `,
    ``,
    `Use --remote if you want to access the remote instance.`,
    ``,
    `✅ No migrations to apply!`,
  ].join("\n");

  it("reads every name out of the table, in printed order", () => {
    expect(parseMigrationsList(pending)).toEqual([
      "0001_foundation.sql",
      "0002_board.sql",
      "0003_parked.sql",
      "0004_map.sql",
      "0005_tags.sql",
    ]);
  });

  it("reads 'No migrations to apply' as nothing pending", () => {
    expect(parseMigrationsList(none)).toEqual([]);
  });
});

describe("stagingGateMessage", () => {
  it("names every pending migration and points at deploy:staging", () => {
    expect(stagingGateMessage(["0004_map.sql", "0005_tags.sql"])).toBe(
      "0004_map.sql, 0005_tags.sql not yet applied on staging: run pnpm deploy:staging first",
    );
  });

  it("names a single pending migration the same way", () => {
    expect(stagingGateMessage(["0005_tags.sql"])).toBe(
      "0005_tags.sql not yet applied on staging: run pnpm deploy:staging first",
    );
  });
});

describe("TABLE_LIST_SQL", () => {
  it("lists real tables only, leaving SQLite's and D1's own out", () => {
    const db = new DatabaseSync(":memory:");
    db.exec("CREATE TABLE task (id TEXT); CREATE TABLE _cf_KV (k TEXT);");
    const names = db.prepare(TABLE_LIST_SQL).all().map((r) => r.name);
    expect(names).toEqual(["task"]);
  });
});

describe("notEmptyRefusal", () => {
  it("is null only when the database holds no tables", () => {
    expect(notEmptyRefusal("vemi", [])).toBeNull();
    expect(notEmptyRefusal("vemi", ["task"])).not.toBeNull();
  });

  it("names the database and every table found, d1_migrations included", () => {
    expect(notEmptyRefusal("vemi", ["d1_migrations", "task"])).toBe(
      "vemi already holds d1_migrations, task: move-in only loads into a new, empty database",
    );
    expect(notEmptyRefusal("vemi", ["d1_migrations"])).toContain("d1_migrations");
  });
});

describe("moveInSql", () => {
  const dump = [
    `INSERT INTO "task" ("id") VALUES ('t1');`,
    `INSERT INTO "credential" ("id") VALUES ('c1');`,
    `INSERT INTO "throttle" ("id") VALUES ('x1');`,
  ].join("\n");

  it("leaves the dump unchanged for production", () => {
    expect(moveInSql(dump, false)).toBe(dump);
  });

  it("drops exactly the left-out tables' rows for staging", () => {
    expect(moveInSql(dump, true)).toBe(`INSERT INTO "task" ("id") VALUES ('t1');`);
    expect(moveInSql(dump, true)).toBe(withoutTables(dump, LEFT_OUT_OF_STAGING));
  });
});

describe("tablesInDump", () => {
  it("reads IF NOT EXISTS, quoted and bare names, in order", () => {
    const dump = [
      `CREATE TABLE IF NOT EXISTS d1_migrations (id INTEGER PRIMARY KEY);`,
      `CREATE TABLE "task" (id TEXT);`,
      `CREATE TABLE tenant (id TEXT);`,
      `INSERT INTO "task" ("id") VALUES ('CREATE TABLE nope');`,
    ].join("\n");
    expect(tablesInDump(dump)).toEqual(["d1_migrations", "task", "tenant"]);
  });
});

describe("inRestoreOrder", () => {
  // The shape of a real export after 0008: project references stage, which was created later.
  const dump = [
    "PRAGMA defer_foreign_keys=TRUE;",
    `CREATE TABLE venture (id TEXT PRIMARY KEY);`,
    `INSERT INTO "venture" ("id") VALUES('v1');`,
    "CREATE TABLE project (",
    "  id TEXT PRIMARY KEY,",
    "  venture_id TEXT REFERENCES venture (id),",
    "  parent_id TEXT REFERENCES project (id)",
    ", stage_id TEXT REFERENCES stage (id));",
    `INSERT INTO "project" ("id","venture_id","parent_id","stage_id") VALUES('p1','v1',NULL,'s1');`,
    `INSERT INTO "project" ("id","venture_id","parent_id","stage_id") VALUES('p2','v1','p1',NULL);`,
    "CREATE TABLE stage (id TEXT PRIMARY KEY, venture_id TEXT REFERENCES venture (id));",
    `INSERT INTO "stage" ("id","venture_id") VALUES('s1','v1');`,
    "DELETE FROM sqlite_sequence;",
    "CREATE INDEX project_by_venture ON project (venture_id);",
  ].join("\n");

  it("moves a referenced table and its rows ahead of the table that references it", () => {
    const lines = inRestoreOrder(dump).split("\n");
    expect(lines[0]).toBe("PRAGMA defer_foreign_keys=TRUE;");
    expect(lines.findIndex((l) => l.startsWith("CREATE TABLE stage"))).toBeLessThan(lines.indexOf("CREATE TABLE project ("));
    expect(lines.slice(-2)).toEqual(["DELETE FROM sqlite_sequence;", "CREATE INDEX project_by_venture ON project (venture_id);"]);
    expect([...lines].sort()).toEqual(dump.split("\n").sort());
  });

  it("restores with foreign keys enforced, where the export as written does not", () => {
    const load = (sql: string) => {
      const db = new DatabaseSync(":memory:");
      db.exec("PRAGMA foreign_keys = ON;");
      db.exec(sql.replace("DELETE FROM sqlite_sequence;", "").replace("PRAGMA defer_foreign_keys=TRUE;", ""));
      return db.prepare("SELECT count(*) AS n FROM project").get();
    };
    expect(() => load(dump)).toThrow(/no such table/);
    expect(load(inRestoreOrder(dump))).toEqual({ n: 2 });
  });

  it("leaves a dump already in order as it is", () => {
    const ordered = inRestoreOrder(dump);
    expect(inRestoreOrder(ordered)).toBe(ordered);
  });

  it("ignores a reference written inside a row", () => {
    const rows = `CREATE TABLE note (id TEXT);\nINSERT INTO "note" ("id") VALUES('REFERENCES zebra (id)');\nCREATE TABLE zebra (id TEXT);`;
    expect(inRestoreOrder(rows)).toBe(rows);
  });

  it("refuses tables that reference each other", () => {
    const cycle = "CREATE TABLE a (b_id TEXT REFERENCES b (id));\nCREATE TABLE b (a_id TEXT REFERENCES a (id));";
    expect(() => inRestoreOrder(cycle)).toThrow(/cycle/);
  });
});
