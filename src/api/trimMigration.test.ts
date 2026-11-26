import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrationStatements, testDb } from "./testing/d1.js";

/**
 * 0014_trim over a database holding 0001 to 0013 and every cut kind. Each assertion maps to
 * one data rule of the trim phase. The migration is applied twice; the second run must
 * change nothing.
 */

type Row = Record<string, unknown>;
const T = (n: number) => `2024-01-0${n}T00:00:00.000Z`;
const TABLES = ["task", "note", "venture", "duty", "venture_link", "milestone", "state", "project", "trim_converted"];

describe("0014_trim over a database holding 0001 to 0013", () => {
  let old: Awaited<ReturnType<typeof testDb>>;
  const go = (sql: string, ...binds: unknown[]) => old.db.prepare(sql).bind(...binds).run();
  const all = async (sql: string): Promise<Row[]> => (await old.db.prepare(sql).all<Row>()).results;
  const first = async (sql: string): Promise<Row> => (await old.db.prepare(sql).first<Row>())!;
  const apply = async () => {
    for (const sql of migrationStatements((f) => f.startsWith("0014_"))) await old.db.prepare(sql).run();
  };
  const counts = async (): Promise<Record<string, number>> => {
    const out: Record<string, number> = {};
    for (const t of TABLES) {
      const exists = await first(`SELECT count(*) AS n FROM sqlite_master WHERE name = '${t}'`);
      out[t] = exists.n === 0 ? 0 : (await first(`SELECT count(*) AS n FROM ${t}`)).n as number;
    }
    return out;
  };
  const rowsOf = async () => Object.fromEntries(await Promise.all(
    ["task", "note", "venture", "duty", "venture_link", "trim_converted"].map(
      async (t) => [t, await all(`SELECT * FROM ${t} ORDER BY ${t === "trim_converted" ? "kind, id" : "id"}`)] as const)));

  beforeAll(async () => {
    old = await testDb({ through: "0013_owner_indexes.sql" });
    const o = "owner-a";
    await go(`INSERT INTO tenant (id, created_at) VALUES (?, ?)`, o, T(1));
    for (const [id, name, desc] of [["v1", "One", "About one"], ["v2", "Two", null], ["v3", "Three", null]] as const) {
      await go(`INSERT INTO venture (id, owner, name, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`, id, o, name, desc, T(1), T(1));
    }
    await go(`INSERT INTO venture_link (id, owner, a_id, b_id, created_at, updated_at) VALUES ('l1', ?, 'v1', 'v2', ?, ?)`, o, T(1), T(1));
    // v1 states: an archived not_started first, then the real first, then a later one.
    const st = (id: string, v: string, kind: string, pos: number, archived: string | null = null) =>
      go(`INSERT INTO state (id, owner, venture_id, name, kind, position, created_at, updated_at, archived_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, id, o, v, id, kind, pos, T(1), T(1), archived);
    await st("s-arch", "v1", "not_started", 0, T(2));
    await st("s-late", "v1", "not_started", 5);
    await st("s-first", "v1", "not_started", 1);
    await st("s-under", "v1", "underway", 0);
    await st("s2-under", "v2", "underway", 0); // v2 has no not_started state
    await go(`INSERT INTO project (id, owner, venture_id, name, created_at, updated_at) VALUES ('p1', ?, 'v1', 'P', ?, ?)`, o, T(1), T(1));
    await go(`INSERT INTO milestone (id, owner, project_id, name, created_at, updated_at) VALUES ('m1', ?, 'p1', 'Beta', ?, ?)`, o, T(1), T(1));
    await go(`INSERT INTO milestone (id, owner, project_id, name, created_at, updated_at) VALUES ('m2', ?, 'p1', 'Quiet', ?, ?)`, o, T(1), T(1));
    const task = (id: string, v: string, body: string | null, state: string | null, parked: string | null) =>
      go(`INSERT INTO task (id, owner, venture_id, title, body, state_id, parked_at, icon, size, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'star', 'm', ?, ?)`, id, o, v, id, body, state, parked, T(1), T(1));
    await task("t-parked", "v1", "keep", "s-under", T(3));
    await task("t-parked-nostate", "v2", null, "s2-under", T(3));
    await task("t-free", "v1", null, "s-under", null);
    await task("t-body", "v1", "Existing body", null, null);
    await task("t-empty", "v1", "", null, null);
    const note = (id: string, col: string, target: string, body: string, at: string, archived: string | null = null) =>
      go(`INSERT INTO note (id, owner, ${col}, body, created_at, updated_at, archived_at) VALUES (?, ?, ?, ?, ?, ?, ?)`, id, o, target, body, at, at, archived);
    await note("n-b", "task_id", "t-body", "second note", T(5));
    await note("n-a", "task_id", "t-body", "first note", T(4));
    await note("n-gone", "task_id", "t-body", "archived note", T(6), T(7));
    await note("n-e", "task_id", "t-empty", "only note", T(4));
    await note("m-b", "milestone_id", "m1", "newer", T(6));
    await note("m-a", "milestone_id", "m1", "older", T(2));
    await note("v-keep", "venture_id", "v1", "venture note stays", T(2));
    const duty = (id: string, v: string, name: string, desc: string | null, pos: number, archived: string | null = null) =>
      go(`INSERT INTO duty (id, owner, venture_id, name, description, position, created_at, updated_at, archived_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, id, o, v, name, desc, pos, T(1), T(1), archived);
    await duty("d2", "v1", "Pay rent", "monthly", 2);
    await duty("d1", "v1", "Water plants", null, 1);
    await duty("d-gone", "v1", "Old", null, 0, T(2));
    await duty("d3", "v3", "Alone", "no description above", 1);
  });
  afterAll(() => old.dispose());

  it("converts every cut kind by its rule, then changes nothing on a second run", async () => {
    const before = await counts();
    await apply();
    const after = await counts();
    // eslint-disable-next-line no-console
    console.log("trim counts before", JSON.stringify(before), "after", JSON.stringify(after));

    // Parked tasks.
    const parked = await all(`SELECT id, state_id, parked_at FROM task WHERE id LIKE 't-parked%' ORDER BY id`);
    expect(parked).toEqual([
      { id: "t-parked", state_id: "s-first", parked_at: null },
      { id: "t-parked-nostate", state_id: "s2-under", parked_at: null },
    ]);
    expect((await first(`SELECT state_id FROM task WHERE id = 't-free'`)).state_id).toBe("s-under");

    // Task notes.
    const body = async (id: string) => (await first(`SELECT body FROM task WHERE id = '${id}'`)).body;
    expect(await body("t-body")).toBe("Existing body\n\nNotes:\nfirst note\n\nsecond note");
    expect(await body("t-empty")).toBe("Notes:\nonly note");
    expect(await body("t-free")).toBeNull();

    // Milestone notes.
    const made = await all(`SELECT id, owner, project_id, milestone_id, body, created_at, updated_at FROM note WHERE id LIKE 'trim-%'`);
    expect(made).toEqual([{
      id: "trim-m-b", owner: "owner-a", project_id: "p1", milestone_id: null,
      body: "Beta\nolder\n\nnewer", created_at: T(6), updated_at: T(6),
    }]);

    // Duties.
    const desc = async (id: string) => (await first(`SELECT description FROM venture WHERE id = '${id}'`)).description;
    expect(await desc("v1")).toBe("About one\n\nDuties:\nWater plants\nPay rent: monthly");
    expect(await desc("v2")).toBeNull();
    expect(await desc("v3")).toBe("Duties:\nAlone: no description above");

    // The record of what was converted.
    const rec = await all(`SELECT kind, id, target_id FROM trim_converted ORDER BY kind, id`);
    expect(rec).toEqual([
      { kind: "duty", id: "d1", target_id: "v1" },
      { kind: "duty", id: "d2", target_id: "v1" },
      { kind: "duty", id: "d3", target_id: "v3" },
      { kind: "milestone-note", id: "m-a", target_id: "trim-m-b" },
      { kind: "milestone-note", id: "m-b", target_id: "trim-m-b" },
      { kind: "parked-task", id: "t-parked", target_id: "s-first" },
      { kind: "parked-task", id: "t-parked-nostate", target_id: null },
      { kind: "task-note", id: "n-a", target_id: "t-body" },
      { kind: "task-note", id: "n-b", target_id: "t-body" },
      { kind: "task-note", id: "n-e", target_id: "t-empty" },
    ]);

    // Nothing destroyed, and the cut data left in place.
    expect(after.note).toBe((before.note ?? 0) + 1);
    expect(after.duty).toBe(before.duty);
    expect(after.venture_link).toBe(before.venture_link);
    expect(await first(`SELECT count(*) AS n FROM task WHERE icon = 'star' AND size = 'm'`)).toEqual({ n: 5 });
    expect(await first(`SELECT count(*) AS n FROM note WHERE task_id IS NOT NULL OR milestone_id IS NOT NULL`)).toEqual({ n: 6 });
    expect((await first(`SELECT body FROM note WHERE id = 'v-keep'`)).body).toBe("venture note stays");

    // A second run changes nothing, row for row.
    const once = await rowsOf();
    await apply();
    expect(await rowsOf()).toEqual(once);
    expect(await counts()).toEqual(after);
  });
});
