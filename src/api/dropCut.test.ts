import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyMigrations, splitStatements } from "../local/migrate.js";
import { createSqlBinding } from "../local/sqlD1.js";
import { openSqliteEngine } from "../local/sqliteEngine.js";
import { ROOT, isTestCode, walk } from "../../tests/walk.js";
import { openStore } from "./store.js";
import { migrationFiles, testDb, type TestDb } from "./testing/d1.js";

/**
 * scripts/data/held/0035_drop_cut.sql over a database holding every real migration. The held
 * file is Andy's step, never applied by a script, so this test is the only thing that runs it.
 */

const HELD = readFileSync(join(ROOT, "scripts/data/held/0035_drop_cut.sql"), "utf8");
const DROPPED_TABLES = ["venture_link", "duty"];
const DROPPED_COLUMNS: Record<string, string[]> = {
  task: ["parked_at", "icon", "size"],
  venture: ["board_x", "board_y", "map_x", "map_y", "map_z"],
  project: ["board_x", "board_y"],
  tenant: ["plan"],
};
const DROPPED_INDEXES = ["venture_link_pair", "venture_link_by_owner", "duty_by_venture", "duty_by_owner"];
const T = "2024-01-01T00:00:00.000Z";
const OWNER = "owner-a";
type Row = Record<string, unknown>;

async function seed(db: D1Database): Promise<void> {
  const go = (sql: string, ...binds: unknown[]) => db.prepare(sql).bind(...binds).run();
  await go(`INSERT INTO tenant (id, created_at) VALUES (?, ?)`, OWNER, T);
  await go(`INSERT INTO venture (id, owner, name, map_x, map_y, board_x, board_y, created_at, updated_at) VALUES ('v1', ?, 'One', 1, 2, 3, 4, ?, ?)`, OWNER, T, T);
  await go(`INSERT INTO venture (id, owner, name, created_at, updated_at) VALUES ('v2', ?, 'Two', ?, ?)`, OWNER, T, T);
  await go(`INSERT INTO project (id, owner, venture_id, name, board_x, board_y, created_at, updated_at) VALUES ('p1', ?, 'v1', 'P', 1, 1, ?, ?)`, OWNER, T, T);
  await go(`INSERT INTO milestone (id, owner, project_id, name, created_at, updated_at) VALUES ('m1', ?, 'p1', 'Beta', ?, ?)`, OWNER, T, T);
  await go(`INSERT INTO task (id, owner, venture_id, title, icon, size, parked_at, created_at, updated_at) VALUES ('t1', ?, 'v1', 'T', 'star', 'm', ?, ?, ?)`, OWNER, T, T, T);
  await go(`INSERT INTO note (id, owner, venture_id, body, created_at, updated_at) VALUES ('n-keep', ?, 'v1', 'stays', ?, ?)`, OWNER, T, T);
  await go(`INSERT INTO note (id, owner, task_id, body, created_at, updated_at) VALUES ('n-task', ?, 't1', 'converted', ?, ?)`, OWNER, T, T);
  await go(`INSERT INTO note (id, owner, milestone_id, body, created_at, updated_at) VALUES ('n-ms', ?, 'm1', 'converted', ?, ?)`, OWNER, T, T);
  await go(`INSERT INTO venture_link (id, owner, a_id, b_id, created_at, updated_at) VALUES ('l1', ?, 'v1', 'v2', ?, ?)`, OWNER, T, T);
  await go(`INSERT INTO duty (id, owner, venture_id, name, created_at, updated_at) VALUES ('d1', ?, 'v1', 'Water', ?, ?)`, OWNER, T, T);
  await go(`INSERT INTO trim_converted (kind, id, target_id, at) VALUES ('duty', 'd1', 'v1', ?)`, T);
}

async function tableCounts(db: D1Database): Promise<Record<string, number>> {
  const names = (await db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name <> 'd1_migrations'`).all<Row>()).results.map((r) => String(r.name));
  const out: Record<string, number> = {};
  for (const n of names) out[n] = ((await db.prepare(`SELECT count(*) AS n FROM "${n}"`).first<Row>()) as Row).n as number;
  return out;
}

const applyHeld = async (db: D1Database) => {
  for (const sql of splitStatements(HELD)) await db.prepare(sql).run();
};

describe("0035_drop_cut over a database holding every migration", () => {
  let t: TestDb;
  beforeAll(async () => {
    t = await testDb();
    await seed(t.db);
  });
  afterAll(() => t.dispose());

  it("drops only the cut data, keeps every other row, and exports and restores equal", async () => {
    const before = await tableCounts(t.db);
    await applyHeld(t.db);
    const after = await tableCounts(t.db);
    for (const name of DROPPED_TABLES) expect(after[name], `${name} is gone`).toBeUndefined();
    for (const name of Object.keys(before).filter((n) => !DROPPED_TABLES.includes(n))) {
      const cut = name === "note" ? 2 : 0; // the two converted note rows are the only rows removed
      expect(after[name], name).toBe(before[name]! - cut);
    }
    const master = (await t.db.prepare(`SELECT name FROM sqlite_master`).all<Row>()).results.map((r) => String(r.name));
    for (const name of [...DROPPED_TABLES, ...DROPPED_INDEXES]) expect(master).not.toContain(name);
    for (const [table, cols] of Object.entries(DROPPED_COLUMNS)) {
      const have = (await t.db.prepare(`PRAGMA table_info(${table})`).all<Row>()).results.map((r) => String(r.name));
      for (const c of cols) expect(have, `${table}.${c}`).not.toContain(c);
    }

    const at = new Date("2026-09-14T02:00:00Z");
    const store = openStore({ DB: t.db }, () => at);
    const doc = await store.exportAll(OWNER, at);
    const rows = Object.fromEntries(Object.entries(doc.tables).map(([k, v]) => [k, v.length]));
    const restored = await store.restoreAll(OWNER, { tables: doc.tables as never, settings: doc.settings });
    expect(restored.ok).toBe(true);
    const filled = Object.fromEntries(Object.entries(rows).filter(([, n]) => n > 0));
    if (restored.ok) expect(restored.value.counts).toMatchObject(filled);
    const again = await store.exportAll(OWNER, at);
    expect(Object.fromEntries(Object.entries(again.tables).map(([k, v]) => [k, v.length]))).toEqual(rows);
  });

  it("applies cleanly with the SQLite build local mode uses", async () => {
    const engine = await openSqliteEngine();
    try {
      await applyMigrations(engine, migrationFiles());
      const db = createSqlBinding(engine) as unknown as D1Database;
      await seed(db);
      await applyHeld(db);
      const left = (await db.prepare(`SELECT name FROM sqlite_master WHERE name IN ('venture_link', 'duty')`).all<Row>()).results;
      expect(left).toEqual([]);
    } finally {
      await engine.close();
    }
  });

  it("leaves migrations/ without it", () => {
    expect(readdirSync(join(ROOT, "migrations")).filter((f) => f.startsWith("0035"))).toEqual([]);
  });
});

describe("no SQL in src/api names a dropped column or table", () => {
  const tables = DROPPED_TABLES.join("|");
  // icon, size and plan are also live names elsewhere (venture.icon, project.icon), so they
  // are checked by the drop assertions above and not by this text scan.
  const columns = ["parked_at", "board_x", "board_y", "map_x", "map_y", "map_z"].join("|");
  it("finds none in store.ts or the rest of src/api", () => {
    const hits: string[] = [];
    const named = [
      new RegExp(`\\b(FROM|JOIN|INTO|UPDATE|TABLE)\\s+(${tables})\\b`, "i"),
      new RegExp(`\\b(${columns})\\b`),
    ];
    for (const file of walk("src/api", [".ts"]).filter((f) => !isTestCode(f))) {
      // store.ts keeps the cut names as plain strings (CUT_TABLES, CUT_COLUMNS) so an old
      // export file still restores; they are never put into a statement.
      let inCutList = false;
      readFileSync(join(ROOT, file), "utf8").split("\n").forEach((line, i) => {
        if (/^const CUT_(TABLES|COLUMNS)\b/.test(line)) inCutList = true;
        const listed = inCutList;
        if (inCutList && /;\s*$/.test(line)) inCutList = false;
        if (listed) return;
        if (/^\s*(\*|\/\/|\/\*)/.test(line)) return;
        if (named.some((re) => re.test(line))) hits.push(`${file}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(hits).toEqual([]);
  });
});
