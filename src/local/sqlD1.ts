/**
 * The store's database interface, over any SQL engine.
 *
 * `store.ts` speaks the shape Cloudflare's database binding has: `prepare`, `bind`, `first`,
 * `all`, `run`, `raw` and `batch`, with results as `{ results, success, meta }`. This file
 * gives the same shape over an engine that only knows how to run one statement and how to
 * wrap a few of them in a transaction, so the store runs unchanged on a person's own device.
 *
 * Two rules of the real binding are kept, because the store relies on them. A batch is one
 * transaction, rolled back whole if any statement fails. And a bound value the engine
 * cannot take, `undefined` above all, is refused when it is bound, not quietly stored as null.
 *
 * It names no Cloudflare type: the cast to the store's type is made once, in `store.ts`.
 */

/** What one statement produced. Rows are arrays in column order. */
export interface SqlRun {
  readonly rows: unknown[][];
  readonly columns: string[];
  /** Rows the statement inserted, updated or deleted; 0 for a read. */
  readonly changes: number;
  readonly lastRowId: number;
}

export interface SqlRunner {
  run(sql: string, binds: readonly unknown[]): Promise<SqlRun>;
}

export interface SqlEngine extends SqlRunner {
  /**
   * Runs `fn` between BEGIN and COMMIT, and rolls back if it throws. The statements `fn`
   * runs go through `tx`; any other call to the engine waits until the transaction is over.
   */
  transaction<T>(fn: (tx: SqlRunner) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export interface SqlMeta {
  duration: number;
  changes: number;
  last_row_id: number;
}

export interface SqlResult<T = Record<string, unknown>> {
  results: T[];
  success: true;
  meta: SqlMeta;
}

export interface SqlStatement {
  bind(...values: unknown[]): SqlStatement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  first<T = unknown>(column: string): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<SqlResult<T>>;
  run<T = Record<string, unknown>>(): Promise<SqlResult<T>>;
  raw<T = unknown[]>(options?: { columnNames?: boolean }): Promise<T[]>;
}

export interface SqlBinding {
  prepare(sql: string): SqlStatement;
  batch<T = Record<string, unknown>>(statements: SqlStatement[]): Promise<SqlResult<T>[]>;
}

/** A value the engine takes, as the real binding takes it: nothing that is not data. */
function checked(value: unknown, at: number): unknown {
  if (value === null) return null;
  switch (typeof value) {
    case "string":
    case "number":
      return value;
    case "boolean":
      return value ? 1 : 0;
    case "bigint":
      return value;
    case "object":
      if (value instanceof ArrayBuffer) return new Uint8Array(value);
      if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
      break;
  }
  throw new Error(`Type '${typeof value}' is not supported for the value bound at position ${at + 1}`);
}

/** A cell as the real binding returns it: whole numbers as numbers, bytes as a list. */
function cell(value: unknown): unknown {
  if (typeof value === "bigint") return Number.isSafeInteger(Number(value)) ? Number(value) : value;
  if (value instanceof Uint8Array) return Array.from(value);
  return value;
}

const objects = (run: SqlRun): Record<string, unknown>[] =>
  run.rows.map((row) => Object.fromEntries(run.columns.map((name, i) => [name, cell(row[i])])));

const resultOf = <T>(run: SqlRun, started: number): SqlResult<T> => ({
  results: objects(run) as T[],
  success: true,
  meta: { duration: performance.now() - started, changes: run.changes, last_row_id: run.lastRowId },
});

class Statement implements SqlStatement {
  constructor(
    private readonly engine: SqlEngine,
    readonly sql: string,
    readonly binds: readonly unknown[],
  ) {}

  bind(...values: unknown[]): SqlStatement {
    return new Statement(this.engine, this.sql, values.map(checked));
  }

  async first(column?: string): Promise<never> {
    const run = await this.engine.run(this.sql, this.binds);
    const row = objects(run)[0];
    if (row === undefined) return null as never;
    if (column === undefined) return row as never;
    if (!(column in row)) throw new Error(`No such column: ${column}`);
    return (row[column] ?? null) as never;
  }

  async all(): Promise<never> {
    const started = performance.now();
    return resultOf(await this.engine.run(this.sql, this.binds), started) as never;
  }

  run(): Promise<never> {
    return this.all();
  }

  async raw(options?: { columnNames?: boolean }): Promise<never> {
    const run = await this.engine.run(this.sql, this.binds);
    const rows = run.rows.map((row) => row.map(cell));
    return (options?.columnNames === true ? [run.columns, ...rows] : rows) as never;
  }
}

export function createSqlBinding(engine: SqlEngine): SqlBinding {
  return {
    prepare: (sql) => new Statement(engine, sql, []),
    batch: async <T>(statements: SqlStatement[]): Promise<SqlResult<T>[]> => {
      const own = statements.map((s) => {
        if (!(s instanceof Statement)) throw new Error("A batch takes statements from this binding's own prepare");
        return s;
      });
      return engine.transaction(async (tx) => {
        const out: SqlResult<T>[] = [];
        for (const s of own) {
          const started = performance.now();
          out.push(resultOf<T>(await tx.run(s.sql, s.binds), started));
        }
        return out;
      });
    },
  };
}
