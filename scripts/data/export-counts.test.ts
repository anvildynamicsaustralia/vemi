import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { countsOf, differences, lines } from "./export-counts.mjs";
import { openStore, type Store } from "../../src/api/store.js";
import { testDb, type TestDb } from "../../src/api/testing/d1.js";

const NOW = new Date("2026-11-22T02:00:00Z");
let t: TestDb;
let store: Store;
let owner: string;

beforeAll(async () => {
  t = await testDb();
  store = openStore({ DB: t.db }, () => NOW);
  owner = `owner-${crypto.randomUUID()}`;
  expect(await store.createAccount({ id: owner, email: `${owner}@example.test`, passwordHash: "x", googleSub: null, confirmed: true })).toBe(true);
});
afterAll(() => t.dispose());

describe("export-counts", () => {
  it("counts every kind in a real export", async () => {
    const a = await store.create(owner, "ventures", { name: "Workshop" });
    const b = await store.create(owner, "ventures", { name: "Garden" });
    if (!a.ok || !b.ok) throw new Error("seed failed");
    const doc = await store.exportAll(owner, NOW);
    const counts = countsOf(JSON.parse(JSON.stringify(doc)));
    expect(counts.venture).toBe(2);
    expect(Object.keys(counts)).toEqual(Object.keys(doc.tables).sort());
    for (const [k, n] of Object.entries(counts)) expect(n).toBe((doc.tables as Record<string, unknown[]>)[k].length);
    expect(lines(counts)).toContain("venture: 2");
  });

  it("says equal for two exports of the same data and names a difference otherwise", async () => {
    const one = countsOf(JSON.parse(JSON.stringify(await store.exportAll(owner, NOW))));
    const two = countsOf(JSON.parse(JSON.stringify(await store.exportAll(owner, NOW))));
    expect(differences(one, two)).toEqual([]);
    const made = await store.create(owner, "ventures", { name: "Another" });
    expect(made.ok).toBe(true);
    const three = countsOf(JSON.parse(JSON.stringify(await store.exportAll(owner, NOW))));
    // A new space brings its own stages and states, so those lines differ too.
    expect(differences(one, three)).toContain("venture: 2 against 3");
    expect(differences(one, three).length).toBeGreaterThan(0);
  });

  it("refuses a file that is not an export", () => {
    expect(() => countsOf({})).toThrow(/not a VEMI export/);
    expect(() => countsOf({ tables: { task: 3 } })).toThrow(/not a list/);
  });
});
