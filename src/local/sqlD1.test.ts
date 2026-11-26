import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSqlBinding, type SqlBinding, type SqlEngine } from "./sqlD1.js";
import { openSqliteEngine } from "./sqliteEngine.js";

let engine: SqlEngine;
let db: SqlBinding;

beforeEach(async () => {
  engine = await openSqliteEngine();
  db = createSqlBinding(engine);
  await db.prepare(`CREATE TABLE thing (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, n INTEGER)`).run();
});
afterEach(async () => {
  await engine.close();
});

describe("the stand-in's D1 shape", () => {
  it("returns results, success and meta from a write and a read", async () => {
    const write = await db.prepare(`INSERT INTO thing (name, n) VALUES (?, ?)`).bind("a", 1).run();
    expect(write.success).toBe(true);
    expect(write.results).toEqual([]);
    expect(write.meta.changes).toBe(1);
    expect(write.meta.last_row_id).toBe(1);
    expect(typeof write.meta.duration).toBe("number");
    const read = await db.prepare(`SELECT * FROM thing`).all();
    expect(read.results).toEqual([{ id: 1, name: "a", n: 1 }]);
    expect(read.meta.changes).toBe(0);
  });

  it("first() gives the row, the column, or null", async () => {
    await db.prepare(`INSERT INTO thing (name, n) VALUES ('a', 1), ('b', 2)`).run();
    expect(await db.prepare(`SELECT count(*) AS count FROM thing`).first("count")).toBe(2);
    expect(await db.prepare(`SELECT * FROM thing WHERE name = ?`).bind("b").first()).toEqual({ id: 2, name: "b", n: 2 });
    expect(await db.prepare(`SELECT * FROM thing WHERE name = ?`).bind("zz").first()).toBeNull();
    expect(await db.prepare(`SELECT * FROM thing WHERE name = ?`).bind("zz").first("n")).toBeNull();
  });

  it("raw() gives arrays, with the names first on request", async () => {
    await db.prepare(`INSERT INTO thing (name, n) VALUES ('a', 1)`).run();
    expect(await db.prepare(`SELECT name, n FROM thing`).raw()).toEqual([["a", 1]]);
    expect(await db.prepare(`SELECT name, n FROM thing`).raw({ columnNames: true })).toEqual([["name", "n"], ["a", 1]]);
    expect(await db.prepare(`SELECT name, n FROM thing WHERE 0`).raw({ columnNames: true })).toEqual([["name", "n"]]);
  });

  it("returns the rows of RETURNING *", async () => {
    const row = await db.prepare(`INSERT INTO thing (name, n) VALUES (?, ?) RETURNING *`).bind("a", 5).first();
    expect(row).toEqual({ id: 1, name: "a", n: 5 });
    const gone = await db.prepare(`DELETE FROM thing WHERE name = ? RETURNING *`).bind("a").all();
    expect(gone.results).toEqual([{ id: 1, name: "a", n: 5 }]);
  });

  it("counts changes on update and delete", async () => {
    await db.prepare(`INSERT INTO thing (name, n) VALUES ('a', 1), ('b', 1), ('c', 2)`).run();
    expect((await db.prepare(`UPDATE thing SET n = 9 WHERE n = 1`).run()).meta.changes).toBe(2);
    expect((await db.prepare(`UPDATE thing SET n = 9 WHERE n = 77`).run()).meta.changes).toBe(0);
    expect((await db.prepare(`DELETE FROM thing WHERE n = 9`).run()).meta.changes).toBe(2);
  });

  it("bind returns a new statement and leaves the first unbound", async () => {
    const base = db.prepare(`SELECT ? AS v`);
    const one = base.bind(1);
    const two = base.bind(2);
    expect(await one.first("v")).toBe(1);
    expect(await two.first("v")).toBe(2);
  });

  it("stores booleans as 1 and 0 and null as null", async () => {
    await db.prepare(`INSERT INTO thing (name, n) VALUES (?, ?)`).bind("t", true).run();
    await db.prepare(`INSERT INTO thing (name, n) VALUES (?, ?)`).bind("f", null).run();
    expect(await db.prepare(`SELECT n FROM thing WHERE name = 't'`).first("n")).toBe(1);
    expect(await db.prepare(`SELECT n FROM thing WHERE name = 'f'`).first("n")).toBeNull();
  });

  it("refuses to bind undefined, as D1 does", () => {
    expect(() => db.prepare(`SELECT ?`).bind(undefined)).toThrow(/undefined/);
    expect(() => db.prepare(`SELECT ?`).bind({})).toThrow();
  });

  it("surfaces a constraint failure as an error with SQLite's own text", async () => {
    await db.prepare(`INSERT INTO thing (name) VALUES ('a')`).run();
    await expect(db.prepare(`INSERT INTO thing (name) VALUES ('a')`).run()).rejects.toThrow(/UNIQUE constraint failed/);
  });

  it("has JSON1", async () => {
    expect(await db.prepare(`SELECT json_object('a', 1) AS j`).first("j")).toBe(`{"a":1}`);
  });
});

describe("batch", () => {
  it("returns one result per statement, in order", async () => {
    const out = await db.batch([
      db.prepare(`INSERT INTO thing (name) VALUES (?)`).bind("a"),
      db.prepare(`SELECT name FROM thing`),
      db.prepare(`UPDATE thing SET n = 3`),
    ]);
    expect(out).toHaveLength(3);
    expect(out[0]?.meta.changes).toBe(1);
    expect(out[1]?.results).toEqual([{ name: "a" }]);
    expect(out[2]?.meta.changes).toBe(1);
  });

  it("is atomic: a failing second statement leaves the first not applied", async () => {
    await expect(
      db.batch([
        db.prepare(`INSERT INTO thing (name) VALUES ('kept-out')`),
        db.prepare(`INSERT INTO nowhere (x) VALUES (1)`),
      ]),
    ).rejects.toThrow();
    expect(await db.prepare(`SELECT count(*) AS count FROM thing`).first("count")).toBe(0);
  });

  it("is atomic on a constraint failure too, and a later batch still works", async () => {
    await db.prepare(`INSERT INTO thing (name) VALUES ('a')`).run();
    await expect(
      db.batch([
        db.prepare(`INSERT INTO thing (name) VALUES ('b')`),
        db.prepare(`INSERT INTO thing (name) VALUES ('a')`),
      ]),
    ).rejects.toThrow(/UNIQUE/);
    expect(await db.prepare(`SELECT count(*) AS count FROM thing`).first("count")).toBe(1);
    await db.batch([db.prepare(`INSERT INTO thing (name) VALUES ('c')`)]);
    expect(await db.prepare(`SELECT count(*) AS count FROM thing`).first("count")).toBe(2);
  });

  it("does not let a separate call slip into an open batch", async () => {
    const batch = db.batch([
      db.prepare(`INSERT INTO thing (name) VALUES ('a')`),
      db.prepare(`INSERT INTO nowhere (x) VALUES (1)`),
    ]);
    const read = db.prepare(`SELECT count(*) AS count FROM thing`).first("count");
    await expect(batch).rejects.toThrow();
    expect(await read).toBe(0);
  });
});
