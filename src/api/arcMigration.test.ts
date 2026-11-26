import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_STAGES } from "./store.js";
import { migrationStatements, testDb, type TestDb } from "./testing/d1.js";

/**
 * 0008 run against rows that predate it: a database stopped at 0007, three ventures, then the
 * arc migration. The default ten must arrive for every venture, archived or not.
 */

let t: TestDb;
const AT = "2020-01-01T00:00:00.000Z";
const ventures = [
  { id: "v-one", owner: "owner-a", archived: null },
  { id: "v-two", owner: "owner-a", archived: AT },
  { id: "v-three", owner: "owner-b", archived: null },
];

beforeAll(async () => {
  t = await testDb({ through: "0007_ledger.sql" });
  for (const v of ventures) {
    await t.db.prepare(
      `INSERT INTO venture (id, owner, name, created_at, updated_at, archived_at) VALUES (?, ?, ?, ?, ?, ?)`,
    ).bind(v.id, v.owner, v.id, AT, AT, v.archived).run();
  }
  await t.db.prepare(
    `INSERT INTO project (id, owner, venture_id, name, created_at, updated_at) VALUES ('p-one', 'owner-a', 'v-one', 'Slice', ?, ?)`,
  ).bind(AT, AT).run();
  for (const sql of migrationStatements((f) => f === "0008_arc.sql")) await t.db.prepare(sql).run();
});
afterAll(() => t.dispose());

describe("0008_arc over existing rows", () => {
  it("gives every venture, archived included, exactly the default ten for its own owner", async () => {
    for (const v of ventures) {
      const rows = await t.db.prepare(
        `SELECT name, kind, position, owner FROM stage WHERE venture_id = ? ORDER BY position`,
      ).bind(v.id).all<{ name: string; kind: string; position: number; owner: string }>();
      expect(rows.results.map((r) => ({ name: r.name, kind: r.kind, position: r.position }))).toEqual(
        DEFAULT_STAGES.map((s, n) => ({ name: s.name, kind: s.kind, position: n + 1 })),
      );
      for (const r of rows.results) expect(r.owner).toBe(v.owner);
    }
  });

  it("leaves every venture and project not at risk and at no stage", async () => {
    for (const table of ["venture", "project"]) {
      const rows = await t.db.prepare(`SELECT at_risk, stage_id FROM ${table}`).all<{ at_risk: number; stage_id: string | null }>();
      expect(rows.results.length).toBeGreaterThan(0);
      for (const r of rows.results) expect(r).toEqual({ at_risk: 0, stage_id: null });
    }
  });
});
