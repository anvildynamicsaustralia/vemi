/**
 * A real D1 for tests, from wrangler's own `getPlatformProxy`, with the migrations applied.
 * With `VEMI_D1=sqlite` it is the on-device stand-in instead, on the SQLite WASM engine in
 * memory, so the same suites run against the other database.
 *
 * It reads `wrangler.jsonc`, so the database under test is bound exactly as the deployed
 * one is, and it persists to a fresh temporary directory, so every test file starts empty.
 * Nothing here is pinned to Miniflare's own API; wrangler owns that.
 *
 * Test code reaches the binding here so that no application file has to. The walk in
 * `tests/d1-one-file.test.ts` names this directory as test code, which is what it is.
 *
 * `queries()` counts round trips at the binding: every `first`, `all`, `run` and `raw`
 * is one, and a `batch` is one however many statements it carries, because D1 sends and
 * runs it as one. That is what "one round trip" means, measured rather than asserted.
 */
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll } from "vitest";
import { applyMigrations, splitStatements } from "../../local/migrate.js";
import { createSqlBinding } from "../../local/sqlD1.js";
import { openSqliteEngine } from "../../local/sqliteEngine.js";

/** The repo root, where `wrangler.jsonc`, `migrations/` and `node_modules` live. */
export const API_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const MIGRATIONS = join(API_ROOT, "migrations");

/** The migration files in order. `only` keeps the ones it accepts, by file name. */
export function migrationFiles(only: (file: string) => boolean = () => true): { name: string; sql: string }[] {
  return readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql") && only(f))
    .sort()
    .map((name) => ({ name, sql: readFileSync(join(MIGRATIONS, name), "utf8") }));
}

/**
 * The migrations as single statements, split by the splitter the on-device database uses.
 * `only` keeps the files it accepts, by file name, so a test can apply one migration to a
 * database that stopped at the one before it.
 */
export function migrationStatements(only: (file: string) => boolean = () => true): string[] {
  return migrationFiles(only).flatMap((f) => splitStatements(f.sql));
}

export interface TestDb {
  readonly db: D1Database;
  /** Round trips since the last `resetCount()`. */
  queries(): number;
  resetCount(): void;
  dispose(): Promise<void>;
}

const INNER = Symbol("inner");

export interface TestDbOptions {
  /** Apply migrations up to and including this file name, and no later ones. */
  readonly through?: string;
}

/**
 * One platform proxy (one workerd) is the slow part of a test database: seconds to boot and a
 * few hundred megabytes. A file that asked for a database per case booted one per case. Now
 * `dispose()` wipes a proxy back to exactly what the migrations left and keeps it for the next
 * `testDb()` in the same file; the file's last `afterAll` shuts them all down. A case that
 * changed the schema, or whose wipe fails, gets its proxy shut down instead, so nothing carries
 * from one case to the next. Every case still sees the database the migrations made.
 */
interface Pooled {
  readonly key: string;
  readonly raw: D1Database;
  readonly shutdown: () => Promise<void>;
  readonly tables: readonly string[];
  readonly schema: string;
  readonly seed: readonly { table: string; columns: string[]; rows: unknown[][] }[];
}

const idle: Pooled[] = [];
const live = new Set<Pooled>();
let hooked = false;

async function schemaOf(raw: D1Database): Promise<string> {
  const { results } = await raw.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE '_cf_%' ORDER BY type, name").all();
  return JSON.stringify(results);
}

async function boot(through: string | undefined): Promise<Pooled> {
  const upTo = (f: string): boolean => through === undefined || f <= through;
  let raw: D1Database;
  let shutdown: () => Promise<void>;
  if (process.env.VEMI_D1 === "sqlite") {
    const engine = await openSqliteEngine();
    await applyMigrations(engine, migrationFiles(upTo));
    raw = createSqlBinding(engine) as unknown as D1Database;
    shutdown = () => engine.close();
  } else {
    const { getPlatformProxy } = await import("wrangler");
    const persist = mkdtempSync(join(tmpdir(), "vemi-d1-"));
    const proxy = await getPlatformProxy<{ DB: D1Database }>({
      configPath: join(API_ROOT, "wrangler.jsonc"),
      persist: { path: persist },
      remoteBindings: false,
    });
    raw = proxy.env.DB;
    for (const sql of migrationStatements(upTo)) await raw.prepare(sql).run();
    shutdown = async () => {
      await proxy.dispose();
      rmSync(persist, { recursive: true, force: true });
    };
  }
  const listed = await raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'").all<{ name: string }>();
  const tables = listed.results.map((r) => r.name);
  const seed: { table: string; columns: string[]; rows: unknown[][] }[] = [];
  for (const table of tables) {
    const got = (await raw.prepare(`SELECT * FROM "${table}"`).raw({ columnNames: true })) as unknown as [string[], ...unknown[][]];
    const [columns, ...rows] = got;
    if (rows.length > 0) seed.push({ table, columns, rows });
  }
  return { key: through ?? "", raw, shutdown, tables, schema: await schemaOf(raw), seed };
}

/** Empties every table, then puts back the rows the migrations themselves wrote. */
async function wipe(p: Pooled): Promise<void> {
  const statements = [
    p.raw.prepare("PRAGMA defer_foreign_keys = on"),
    ...p.tables.map((t) => p.raw.prepare(`DELETE FROM "${t}"`)),
  ];
  for (const s of p.seed) {
    const marks = s.columns.map(() => "?").join(", ");
    const names = s.columns.map((c) => `"${c}"`).join(", ");
    for (const row of s.rows) statements.push(p.raw.prepare(`INSERT INTO "${s.table}" (${names}) VALUES (${marks})`).bind(...row));
  }
  await p.raw.batch(statements);
  const counter = await p.raw.prepare("SELECT 1 AS x FROM sqlite_master WHERE name = 'sqlite_sequence'").first();
  if (counter) await p.raw.prepare("DELETE FROM sqlite_sequence").run();
}

async function giveBack(p: Pooled): Promise<void> {
  try {
    if ((await schemaOf(p.raw)) === p.schema) {
      await wipe(p);
      idle.push(p);
      return;
    }
  } catch {
    // A database that cannot be wiped is not reused.
  }
  live.delete(p);
  await p.shutdown();
}

export async function testDb(options: TestDbOptions = {}): Promise<TestDb> {
  const { through } = options;
  if (!hooked) {
    hooked = true;
    afterAll(async () => {
      const left = [...live];
      live.clear();
      idle.length = 0;
      await Promise.allSettled(left.map((p) => p.shutdown()));
    });
  }
  const at = idle.findIndex((p) => p.key === (through ?? ""));
  let pooled: Pooled;
  if (at >= 0) pooled = idle.splice(at, 1)[0]!;
  else {
    pooled = await boot(through);
    live.add(pooled);
  }
  const raw = pooled.raw;
  const release = (): Promise<void> => giveBack(pooled);

  let count = 0;
  const statement = (inner: D1PreparedStatement): D1PreparedStatement => ({
    [INNER]: inner,
    bind: (...values: unknown[]) => statement(inner.bind(...values)),
    first: (column?: string) => {
      count++;
      return column === undefined ? inner.first() : inner.first(column);
    },
    all: () => {
      count++;
      return inner.all();
    },
    run: () => {
      count++;
      return inner.run();
    },
    raw: (options?: { columnNames?: boolean }) => {
      count++;
      return inner.raw(options as { columnNames: true });
    },
  }) as unknown as D1PreparedStatement;

  const db = {
    prepare: (sql: string) => statement(raw.prepare(sql)),
    batch: (statements: D1PreparedStatement[]) => {
      count++;
      return raw.batch(statements.map((s) => (s as unknown as { [INNER]: D1PreparedStatement })[INNER]));
    },
    exec: (sql: string) => {
      count++;
      return raw.exec(sql);
    },
  } as unknown as D1Database;

  return {
    db,
    queries: () => count,
    resetCount: () => {
      count = 0;
    },
    dispose: release,
  };
}
