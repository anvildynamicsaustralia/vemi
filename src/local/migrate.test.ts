import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { applyMigrations, bundledMigrations, splitStatements } from "./migrate.js";
import { openSqliteEngine } from "./sqliteEngine.js";
import type { SqlEngine } from "./sqlD1.js";

const ON_DISK = readdirSync(join(import.meta.dirname, "..", "..", "migrations")).filter((f) => f.endsWith(".sql")).sort();

let engine: SqlEngine;
beforeEach(async () => {
  engine = await openSqliteEngine();
});
afterEach(async () => {
  await engine.close();
});

describe("splitStatements", () => {
  it("drops comment lines and splits on a semicolon that ends a line", () => {
    expect(splitStatements("-- a\nCREATE TABLE a (x);\n-- b\nINSERT INTO a VALUES ('p;q');\n")).toEqual([
      "CREATE TABLE a (x)",
      "INSERT INTO a VALUES ('p;q')",
    ]);
  });
});

describe("applyMigrations", () => {
  it("reads every file in migrations/, in order", async () => {
    const files = await bundledMigrations();
    expect(files.map((f) => f.name)).toEqual(ON_DISK);
    expect(files.length).toBeGreaterThan(30);
  });

  it("applies every file once, and a re-open applies none", async () => {
    const files = await bundledMigrations();
    expect(await applyMigrations(engine, files)).toEqual(ON_DISK);
    const tables = await engine.run(`SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'account'`, []);
    expect(tables.rows[0]).toEqual([1]);
    expect(await applyMigrations(engine, files)).toEqual([]);
  });

  it("applies only the files that are new to a database that stopped earlier", async () => {
    const files = await bundledMigrations();
    expect(await applyMigrations(engine, files.slice(0, 5))).toEqual(ON_DISK.slice(0, 5));
    expect(await applyMigrations(engine, files)).toEqual(ON_DISK.slice(5));
  });

  it("leaves a failing file wholly unapplied and unrecorded", async () => {
    const good = { name: "0001_ok.sql", sql: "CREATE TABLE ok (x);" };
    const bad = { name: "0002_bad.sql", sql: "CREATE TABLE half (x);\nINSERT INTO nowhere VALUES (1);" };
    await expect(applyMigrations(engine, [good, bad])).rejects.toThrow();
    const half = await engine.run(`SELECT count(*) FROM sqlite_master WHERE name = 'half'`, []);
    expect(half.rows[0]).toEqual([0]);
    expect(await applyMigrations(engine, [good])).toEqual([]);
  });
});
