import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openStore, type Outcome, type Store } from "./store.js";
import { testDb, type TestDb } from "./testing/d1.js";

/** The trim cut some data; the code no longer names it, and a file that still holds it restores. */

const NOW = new Date("2026-09-14T02:00:00Z");
let t: TestDb;
let store: Store;

beforeAll(async () => {
  t = await testDb();
  store = openStore({ DB: t.db }, () => NOW);
});
afterAll(() => t.dispose());

function must<T>(outcome: Outcome<T>): T {
  if (!outcome.ok) throw new Error(`${outcome.status}: ${outcome.error}`);
  return outcome.value;
}

const seed = async (owner: string) => {
  const v = must(await store.create(owner, "ventures", { name: "Studio" })).record;
  const p = must(await store.create(owner, "projects", { ventureId: v.id, name: "Site" })).record;
  must(await store.create(owner, "tasks", { ventureId: v.id, projectId: p.id, title: "Ship it" }));
  return v;
};

const sizes = (tables: Record<string, readonly unknown[]>) =>
  Object.fromEntries(Object.entries(tables).map(([n, rows]) => [n, rows.length]));

describe("the cut data", () => {
  it("restores an old export that still holds the cut keys, and ignores them", async () => {
    const owner = `owner-${crypto.randomUUID()}`;
    await seed(owner);
    const doc = await store.exportAll(owner, NOW);
    const counts = sizes(doc.tables);

    const tables: Record<string, Record<string, unknown>[]> = JSON.parse(JSON.stringify(doc.tables));
    tables.venture = (tables.venture ?? []).map((r) => ({ ...r, map_x: 1.5, map_y: 2, map_z: 3, board_x: 4, board_y: 5 }));
    tables.project = (tables.project ?? []).map((r) => ({ ...r, board_x: 1, board_y: 2 }));
    tables.task = (tables.task ?? []).map((r) => ({ ...r, parked_at: null, icon: "x", size: 3 }));
    tables.venture_link = [{ id: "tie", a_id: "a", b_id: "b", created_at: "x", updated_at: "x" }];
    tables.duty = [{ id: "chore", venture_id: "a", name: "Pay", position: 0, created_at: "x", updated_at: "x" }];

    const restored = must(await store.restoreAll(owner, { tables }));
    for (const [name, n] of Object.entries(restored.counts)) expect(counts[name], name).toBe(n);
    expect(restored.counts).not.toHaveProperty("venture_link");
    expect(restored.counts).not.toHaveProperty("duty");

    const after = await store.exportAll(owner, NOW);
    expect(sizes(after.tables)).toEqual(counts);
    expect(JSON.stringify(after.tables.venture)).not.toMatch(/map_x|map_y|map_z|board_x|board_y/);
    expect(JSON.stringify(after.tables.project)).not.toMatch(/board_x|board_y/);
    expect(JSON.stringify(after.tables.task)).not.toMatch(/parked_at|"icon"|"size"/);
    expect(after.tables).not.toHaveProperty("venture_link");
    expect(after.tables).not.toHaveProperty("duty");
  });

  it("carries no map position on a venture", async () => {
    const owner = `owner-${crypto.randomUUID()}`;
    const v = await seed(owner);
    expect(JSON.stringify(v)).not.toMatch(/mapX|mapY|mapZ/);
  });
});

describe("the cut tables before the held drop", () => {
  const AT = "2026-09-14T02:00:00.000Z";
  const legacyRows = async (owner: string, a: string, b: string) => {
    await t.db.prepare(
      `INSERT INTO duty (id, owner, venture_id, name, position, created_at, updated_at) VALUES (?, ?, ?, 'Pay the hosting', 0, ?, ?)`,
    ).bind(`duty-${crypto.randomUUID()}`, owner, a, AT, AT).run();
    const [x, y] = [a, b].sort();
    await t.db.prepare(
      `INSERT INTO venture_link (id, owner, a_id, b_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
    ).bind(`tie-${crypto.randomUUID()}`, owner, x, y, AT, AT).run();
  };
  const count = async (table: string, owner: string) =>
    (await t.db.prepare(`SELECT count(*) AS n FROM ${table} WHERE owner = ?`).bind(owner).first<{ n: number }>())?.n;

  it("deletes a venture that a legacy duty and venture link still name", async () => {
    const owner = `owner-${crypto.randomUUID()}`;
    const studios = must(await store.create(owner, "ventures", { name: "Studios" })).record;
    const other = must(await store.create(owner, "ventures", { name: "Elsewhere" })).record;
    await legacyRows(owner, studios.id, other.id);
    must(await store.setArchived(owner, "ventures", studios.id, true));
    must(await store.remove(owner, "ventures", studios.id, "Studios"));
    expect(await store.get(owner, "ventures", studios.id)).toBeNull();
    expect(await store.get(owner, "ventures", other.id)).not.toBeNull();
    expect(await count("duty", owner)).toBe(0);
    expect(await count("venture_link", owner)).toBe(0);
  });

  it("restores a file over an account whose legacy duty and venture link rows are still present", async () => {
    const owner = `owner-${crypto.randomUUID()}`;
    const a = must(await store.create(owner, "ventures", { name: "One" })).record;
    const b = must(await store.create(owner, "ventures", { name: "Two" })).record;
    await legacyRows(owner, a.id, b.id);
    const doc = await store.exportAll(owner, NOW);
    const restored = must(await store.restoreAll(owner, { tables: doc.tables as never }));
    expect(restored.counts.venture).toBe(2);
    expect(await count("duty", owner)).toBe(0);
    expect(await count("venture_link", owner)).toBe(0);
  });
});
