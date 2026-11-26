/**
 * The pure half of staging's scripts: SQL text and stdout-parsing, no binding, no
 * subprocess, no filesystem. Plain ESM with JSDoc types, because `src/api/tsconfig.json`
 * includes only the Worker source and nothing under `scripts` is compiled.
 *
 * The impure halves (Tasks 3 and 4) hold the D1 binding, the `wrangler` subprocess calls
 * and the B2 upload; everything here is called only with values they already hold.
 *
 * @typedef {Readonly<Record<string, number>>} CountsByTable
 */

/** A dump's schema statement for a table always opens `CREATE TABLE "<name>"`, never with
 *  quoted brackets around the whole clause, so an `INSERT INTO "<name>"` line can be told
 *  apart from it by that literal prefix. A `wrangler d1 export` file puts one statement per
 *  array element, each ending in `;`, so every statement is its own line once joined. */
const INSERT_LINE = /^INSERT INTO "([^"]+)"/;

/**
 * `sql` with every `INSERT INTO "<t>"` statement for a table in `tables` removed. Schema
 * statements (`CREATE TABLE`, `CREATE INDEX`) are untouched, and so is every other
 * table's data.
 *
 * @param {string} sql
 * @param {readonly string[]} tables
 * @returns {string}
 */
export function withoutTables(sql, tables) {
  const drop = new Set(tables);
  return sql
    .split("\n")
    .filter((line) => {
      const m = INSERT_LINE.exec(line);
      return !(m && drop.has(m[1]));
    })
    .join("\n");
}

/** The tables a staging refresh does not copy from production: the retired passkey
 *  tables, the short-lived mail tokens, and the throttle counters. Staging keeps its own,
 *  empty. `account` is not here: it is copied, so the production password signs in on
 *  staging. */
export const LEFT_OUT_OF_STAGING = ["credential", "recovery_code", "challenge", "email_token", "throttle"];

/**
 * The SQL that empties a database down to its schema: `PRAGMA defer_foreign_keys = on;`
 * so drop order never trips a foreign key, then one `DROP TABLE IF EXISTS "<t>";` per
 * name in `tableNames`, and finally one for `d1_migrations` — wrangler's own bookkeeping
 * table, named nowhere else in this codebase, so a fresh `wrangler d1 migrations apply`
 * re-applies every migration from the top rather than finding them already recorded.
 *
 * @param {readonly string[]} tableNames
 * @returns {string}
 */
export function dropEverything(tableNames) {
  const names = [...tableNames, "d1_migrations"];
  return ["PRAGMA defer_foreign_keys = on;", ...names.map((name) => `DROP TABLE IF EXISTS "${name}";`)].join("\n");
}

/**
 * One `SELECT` that reports every named table's row count as one row, a column per table
 * named for it. Scalar subqueries rather than a `UNION ALL` per table: D1 refuses a
 * compound SELECT past a handful of terms ("too many terms in compound SELECT"), and
 * production has seventeen tables.
 *
 * @param {readonly string[]} tableNames
 * @returns {string}
 */
export function countQuery(tableNames) {
  return `SELECT ${tableNames.map((name) => `(SELECT COUNT(*) FROM "${name}") AS "${name}"`).join(", ")};`;
}

/**
 * `countQuery`'s result rows (there is one) read as table → count.
 *
 * @param {readonly Record<string, unknown>[]} rows
 * @returns {CountsByTable}
 */
export function countsFromRows(rows) {
  /** @type {Record<string, number>} */
  const counts = {};
  for (const row of rows) for (const [name, count] of Object.entries(row)) counts[name] = Number(count);
  return counts;
}

/**
 * Compares two tables' worth of row counts, skipping any table named in `skip`. `[]`
 * means every count outside `skip` matched; otherwise one `"<table>: expected N, found
 * M"` line per table whose count did not.
 *
 * @param {CountsByTable} expected
 * @param {CountsByTable} actual
 * @param {readonly string[]} skip
 * @returns {string[]}
 */
export function compareCounts(expected, actual, skip) {
  const skipped = new Set(skip);
  const lines = [];
  for (const table of Object.keys(expected)) {
    if (skipped.has(table)) continue;
    const wanted = expected[table];
    const found = actual[table] ?? 0;
    if (wanted !== found) lines.push(`${table}: expected ${wanted}, found ${found}`);
  }
  return lines;
}

/**
 * The local migration names that are not yet in `appliedNames`, in the order `localFiles`
 * gave them.
 *
 * @param {readonly string[]} localFiles
 * @param {readonly string[]} appliedNames
 * @returns {string[]}
 */
export function pendingMigrations(localFiles, appliedNames) {
  const applied = new Set(appliedNames);
  return localFiles.filter((name) => !applied.has(name));
}

/** A row of the ASCII table `wrangler d1 migrations list` prints holds one cell between a
 *  pair of `│`; the header cell reads `Name` and every other such cell is a migration's
 *  file name. Captured live against a local database, 2026-09-27:
 *
 *  ```
 *  Migrations to be applied:
 *  ┌─────────────────────┐
 *  │ Name                │
 *  ├─────────────────────┤
 *  │ 0001_foundation.sql │
 *  ├─────────────────────┤
 *  │ 0002_board.sql      │
 *  └─────────────────────┘
 *  ```
 *
 *  and, with nothing pending:
 *
 *  ```
 *  ✅ No migrations to apply!
 *  ```
 */
const TABLE_CELL = /│\s*(.*?)\s*│/gu;

/**
 * Reads the table `wrangler d1 migrations list DB --remote --env staging` prints and
 * returns the pending migration names, in the order printed. Reads "No migrations to
 * apply" as `[]`.
 *
 * @param {string} stdout
 * @returns {string[]}
 */
export function parseMigrationsList(stdout) {
  if (stdout.includes("No migrations to apply")) return [];
  const cells = [...stdout.matchAll(TABLE_CELL)].map((m) => m[1]);
  return cells.filter((cell) => cell !== "" && cell !== "Name");
}

/**
 * The refusal message `proven-on-staging.mjs` exits 1 with when `names` (from
 * `pendingMigrations`) is non-empty: every named migration, comma-separated, then a
 * pointer at the command that applies them.
 *
 * @param {readonly string[]} names
 * @returns {string}
 */
export function stagingGateMessage(names) {
  return `${names.join(", ")} not yet applied on staging: run pnpm deploy:staging first`;
}

/** `sqlite_master`'s own table names, the way `wrangler d1 export` leaves them out: real
 *  tables only, none of SQLite's or D1's own bookkeeping. */
export const TABLE_LIST_SQL =
  "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\' ORDER BY name";

/**
 * Why a database cannot be moved into, or `null` when it can: it holds no tables at all.
 * `d1_migrations` counts as a table, so a database that was migrated but never loaded is
 * refused too.
 *
 * @param {string} databaseName
 * @param {readonly string[]} tableNames
 * @returns {string | null}
 */
export function notEmptyRefusal(databaseName, tableNames) {
  if (tableNames.length === 0) return null;
  return `${databaseName} already holds ${tableNames.join(", ")}: move-in only loads into a new, empty database`;
}

/**
 * The SQL to load: the dump in restore order for production, without the left-out tables' rows
 * for staging.
 *
 * @param {string} dump
 * @param {boolean} staging
 * @returns {string}
 */
export function moveInSql(dump, staging) {
  const ordered = inRestoreOrder(dump);
  return staging ? withoutTables(ordered, LEFT_OUT_OF_STAGING) : ordered;
}

/** A statement that opens a table: `CREATE TABLE`, optionally `IF NOT EXISTS`, then the
 *  name bare or double-quoted. */
const CREATE_TABLE_LINE = /^CREATE TABLE (?:IF NOT EXISTS )?(?:"([^"]+)"|([^\s("]+))/;

/**
 * The table names from every `CREATE TABLE` statement in `dump`, in order.
 *
 * @param {string} dump
 * @returns {string[]}
 */
export function tablesInDump(dump) {
  const names = [];
  for (const line of dump.split("\n")) {
    const m = CREATE_TABLE_LINE.exec(line);
    if (m) names.push(m[1] ?? m[2]);
  }
  return names;
}

/** Where a dump's tables end: the sequence reset and the indexes, which come after every
 *  table and its rows. */
const TAIL_LINE = /^(?:DELETE FROM sqlite_sequence;|INSERT INTO "sqlite_sequence"|CREATE (?:UNIQUE )?INDEX |CREATE TRIGGER |CREATE VIEW )/;
const REFERENCE = /REFERENCES\s+"?([A-Za-z_][A-Za-z0-9_]*)"?/g;

/**
 * `dump` with every table, and the rows after it, moved ahead of any table whose schema
 * references it. An export lists tables in the order they were created, and D1 looks up a
 * foreign key's parent table when a row is inserted, even with the check deferred, so a
 * reference added to an older table by a later migration (`project.stage_id`, 0008)
 * otherwise stops the restore at "no such table". Order is kept wherever it already works.
 * A table referencing itself is fine; a cycle between tables throws, since no order loads it.
 *
 * @param {string} dump
 * @returns {string}
 */
export function inRestoreOrder(dump) {
  /** @type {string[]} */
  const head = [];
  /** @type {string[]} */
  const tail = [];
  /** @type {{ name: string, lines: string[], refs: Set<string> }[]} */
  const blocks = [];
  /** @type {{ name: string, lines: string[], refs: Set<string> } | null} */
  let current = null;
  let inSchema = false;
  for (const line of dump.split("\n")) {
    if (tail.length > 0 || (current !== null && !inSchema && TAIL_LINE.test(line))) {
      tail.push(line);
      continue;
    }
    const m = CREATE_TABLE_LINE.exec(line);
    if (m) {
      current = { name: m[1] ?? m[2], lines: [], refs: new Set() };
      blocks.push(current);
      inSchema = true;
    }
    if (current === null) {
      head.push(line);
      continue;
    }
    current.lines.push(line);
    // Only the CREATE TABLE statement names references; row values never count.
    if (inSchema) {
      for (const ref of line.matchAll(REFERENCE)) if (ref[1] !== current.name) current.refs.add(ref[1]);
      if (/\);\s*$/.test(line)) inSchema = false;
    }
  }
  const present = new Set(blocks.map((b) => b.name));
  const placed = new Set();
  const ordered = [];
  while (ordered.length < blocks.length) {
    const next = blocks.find((b) => !placed.has(b.name) && [...b.refs].every((r) => placed.has(r) || !present.has(r)));
    if (next === undefined) {
      const left = blocks.filter((b) => !placed.has(b.name)).map((b) => b.name);
      throw new Error(`these tables reference each other in a cycle, so no order restores them: ${left.join(", ")}`);
    }
    placed.add(next.name);
    ordered.push(next);
  }
  return [...head, ...ordered.flatMap((b) => b.lines), ...tail].join("\n");
}
