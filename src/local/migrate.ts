/// <reference types="vite/client" />
/**
 * The migrations, applied to a local database.
 *
 * Every file in `migrations/` runs in order, once. What has run is kept in the database's own
 * `user_version`, which holds the count of files applied, so a re-open applies only what is
 * new and the schema carries no bookkeeping table. Each file is one transaction with its
 * count: a file that fails leaves nothing of itself behind.
 *
 * `splitStatements` is the one splitter. The migrations hold no triggers, so a semicolon at
 * the end of a line ends a statement. Tests use it to read the same files from disk.
 */
import type { SqlEngine } from "./sqlD1.js";

export interface MigrationFile {
  readonly name: string;
  readonly sql: string;
}

/** The statements of one migration file: comment lines dropped, split where `;` ends a line. */
export function splitStatements(sql: string): string[] {
  return sql
    .split(/\r?\n/)
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n")
    .split(/;\s*(?:\n|$)/)
    .map((s) => s.trim())
    .filter((s) => s !== "");
}

/** The migrations as the build holds them, in file-name order. */
export async function bundledMigrations(): Promise<MigrationFile[]> {
  const found = import.meta.glob("../../migrations/*.sql", { query: "?raw", import: "default" });
  const files = await Promise.all(
    Object.entries(found).map(async ([path, load]) => ({
      name: path.slice(path.lastIndexOf("/") + 1),
      sql: (await load()) as string,
    })),
  );
  return files.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** Applies the files the database has not had, in order. Returns the names it applied. */
export async function applyMigrations(engine: SqlEngine, files: readonly MigrationFile[]): Promise<string[]> {
  const version = await engine.run("PRAGMA user_version", []);
  const done = Number(version.rows[0]?.[0] ?? 0);
  const applied: string[] = [];
  for (const [index, file] of files.entries()) {
    if (index < done) continue;
    await engine.transaction(async (tx) => {
      for (const statement of splitStatements(file.sql)) await tx.run(statement, []);
      await tx.run(`PRAGMA user_version = ${index + 1}`, []);
    });
    applied.push(file.name);
  }
  return applied;
}
