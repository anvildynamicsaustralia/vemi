/**
 * The SQL engine over SQLite WASM, `@sqlite.org/sqlite-wasm`.
 *
 * `openSqliteEngine()` with no argument is an in-memory database; that is what tests and a
 * first look at the app use. In Node the package's own Node entry loads the wasm from disk,
 * and a browser build gets the browser entry through the package's `exports`.
 *
 * One transaction at a time: the engine queues every call, so a statement from elsewhere
 * can never land inside the transaction another caller has open.
 */
import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import type { SqlEngine, SqlRun, SqlRunner } from "./sqlD1.js";

export interface SqliteOptions {
  /** A SQLite filename; ":memory:" (the default) keeps nothing. */
  readonly filename?: string;
  /**
   * Keep the database in the browser's origin private file system, through the `opfs-sahpool`
   * VFS, under `directory`. Only a dedicated worker can do this, and only one open handle on a
   * directory at a time; where the browser cannot, opening throws and the caller decides.
   */
  readonly opfs?: { readonly directory: string; readonly filename: string };
}

export async function openSqliteEngine(options: SqliteOptions = {}): Promise<SqlEngine> {
  // A failed statement is an exception to the caller; the module need not also print it.
  const quiet = { print: () => undefined, printErr: () => undefined };
  const sqlite3 = await (sqlite3InitModule as (options: typeof quiet) => ReturnType<typeof sqlite3InitModule>)(quiet);
  const { DB: Database } = sqlite3.oo1;
  let db: InstanceType<typeof Database>;
  if (options.opfs) {
    const pool = await sqlite3.installOpfsSAHPoolVfs({ directory: options.opfs.directory, clearOnInit: false });
    db = new pool.OpfsSAHPoolDb(`/${options.opfs.filename}`);
  } else {
    db = new Database(options.filename ?? ":memory:", "c");
  }

  const execute = (sql: string, binds: readonly unknown[]): SqlRun => {
    const columns: string[] = [];
    const before = db.changes(true);
    const rows = db.exec({
      sql,
      bind: binds.length === 0 ? undefined : (binds as never),
      rowMode: "array",
      returnValue: "resultRows",
      columnNames: columns,
    }) as unknown[][];
    const changes = db.changes(true) - before;
    const lastRowId = Number(sqlite3.capi.sqlite3_last_insert_rowid(db));
    return { rows, columns, changes, lastRowId };
  };

  // D1 enforces foreign keys; so does this.
  execute("PRAGMA foreign_keys = ON", []);

  const direct: SqlRunner = { run: async (sql, binds) => execute(sql, binds) };

  let tail: Promise<unknown> = Promise.resolve();
  const queued = <T>(work: () => Promise<T>): Promise<T> => {
    const next = tail.then(work, work);
    tail = next.catch(() => undefined);
    return next;
  };

  return {
    run: (sql, binds) => queued(() => direct.run(sql, binds)),
    transaction: <T>(fn: (tx: SqlRunner) => Promise<T>) =>
      queued(async () => {
        execute("BEGIN", []);
        try {
          const value = await fn(direct);
          execute("COMMIT", []);
          return value;
        } catch (error) {
          if (db.isOpen()) {
            try {
              execute("ROLLBACK", []);
            } catch {
              // SQLite already ended the transaction on this failure; there is nothing to undo.
            }
          }
          throw error;
        }
      }),
    close: () =>
      queued(async () => {
        db.close();
      }),
  };
}
