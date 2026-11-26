import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hashPassword } from "./password.js";
import { openStore, type Outcome, type Store } from "./store.js";
import { migrationStatements, testDb, type TestDb } from "./testing/d1.js";
import { parseCreate, parsePatch } from "./validate.js";

/**
 * 0018_project_brief: a project's who it is for, what done looks like and open questions.
 * All three round-trip through create, patch and the tree; null clears; over-long values
 * are refused; two accounts never see each other's; and the file can be run twice.
 */

type Row = Record<string, unknown>;
const T = "2026-01-01T00:00:00.000Z";
const PASSWORD = "a long enough password";
const NOW = new Date("2026-11-17T02:00:00Z");

function must<V>(outcome: Outcome<V>): V {
  if (!outcome.ok) throw new Error(`${outcome.status}: ${outcome.error}`);
  return outcome.value;
}

describe("0018_project_brief over a database holding 0001 to 0017", () => {
  let old: TestDb;
  const go = (sql: string, ...binds: unknown[]) => old.db.prepare(sql).bind(...binds).run();
  const all = async (sql: string): Promise<Row[]> => (await old.db.prepare(sql).all<Row>()).results;
  const apply = async (again: boolean) => {
    for (const sql of migrationStatements((f) => f.startsWith("0018_"))) {
      try {
        await old.db.prepare(sql).run();
      } catch (e) {
        // SQLite has no ADD COLUMN IF NOT EXISTS; only the three columns may refuse a second pass.
        if (!(again && e instanceof Error && e.message.includes("duplicate column name"))) throw e;
      }
    }
  };

  beforeAll(async () => {
    old = await testDb({ through: "0017_task_remind_repeat.sql" });
    await go(`INSERT INTO tenant (id, created_at) VALUES ('o', ?)`, T);
    await go(`INSERT INTO venture (id, owner, name, created_at, updated_at) VALUES ('v', 'o', 'V', ?, ?)`, T, T);
    await go(`INSERT INTO project (id, owner, venture_id, name, position, created_at, updated_at) VALUES ('p', 'o', 'v', 'Old', 1, ?, ?)`, T, T);
    await apply(false);
  });
  afterAll(() => old.dispose());

  it("adds the three columns, empty, to an existing project", async () => {
    expect((await all(`SELECT who_for, done_looks, open_questions FROM project`))[0])
      .toEqual({ who_for: null, done_looks: null, open_questions: null });
  });

  it("changes nothing when the file is applied a second time", async () => {
    await go(`UPDATE project SET who_for = 'me', done_looks = 'shipped', open_questions = 'why'`);
    const before = await all(`SELECT * FROM project`);
    await apply(true);
    expect(await all(`SELECT * FROM project`)).toEqual(before);
  });
});

describe("a project's brief through the store", () => {
  let t: TestDb;
  let store: Store;
  let passwordHash: string;

  beforeAll(async () => {
    t = await testDb();
    store = openStore({ DB: t.db }, () => NOW);
    passwordHash = await hashPassword(PASSWORD);
  });
  afterAll(() => t.dispose());

  async function account(): Promise<{ owner: string; venture: string }> {
    const owner = `owner-${crypto.randomUUID()}`;
    expect(await store.createAccount({ id: owner, email: `${owner}@example.test`, passwordHash, googleSub: null, confirmed: true })).toBe(true);
    const venture = must(await store.create(owner, "ventures", { id: crypto.randomUUID(), name: "Space" })).record.id;
    return { owner, venture };
  }
  const create = (body: unknown) => {
    const parsed = parseCreate("projects", body);
    if (!parsed.ok) throw new Error(parsed.error);
    return parsed.value;
  };
  const patch = (body: unknown) => {
    const parsed = parsePatch("projects", body);
    if (!parsed.ok) throw new Error(parsed.error);
    return parsed.value;
  };
  const brief = (p: { whoFor: string | null; doneLooks: string | null; openQuestions: string | null } | null | undefined) =>
    [p?.whoFor, p?.doneLooks, p?.openQuestions];

  it("defaults all three to null", async () => {
    const a = await account();
    const made = must(await store.create(a.owner, "projects", create({ id: crypto.randomUUID(), ventureId: a.venture, name: "Plain" }))).record;
    expect(brief(made)).toEqual([null, null, null]);
  });

  it("takes all three on create and returns them from get and the tree", async () => {
    const a = await account();
    const id = crypto.randomUUID();
    const made = must(await store.create(a.owner, "projects", create({
      id, ventureId: a.venture, name: "Full", whoFor: "Me", doneLooks: "Shipped", openQuestions: "What next?",
    }))).record;
    expect(brief(made)).toEqual(["Me", "Shipped", "What next?"]);
    expect(brief(await store.get(a.owner, "projects", id))).toEqual(["Me", "Shipped", "What next?"]);
    const inTree = (await store.tree(a.owner)).ventures[0]!.projects.find((x) => x.id === id);
    expect(brief(inTree)).toEqual(["Me", "Shipped", "What next?"]);
  });

  it("sets by patch, keeps them when other fields change, and clears each with null", async () => {
    const a = await account();
    const id = crypto.randomUUID();
    must(await store.create(a.owner, "projects", create({ id, ventureId: a.venture, name: "Later" })));
    const set = must(await store.update(a.owner, "projects", id, patch({ whoFor: "Kids", doneLooks: "Done", openQuestions: "Q" }))).record;
    expect(brief(set)).toEqual(["Kids", "Done", "Q"]);
    const renamed = must(await store.update(a.owner, "projects", id, patch({ name: "Renamed" }))).record;
    expect(brief(renamed)).toEqual(["Kids", "Done", "Q"]);
    const one = must(await store.update(a.owner, "projects", id, patch({ doneLooks: null }))).record;
    expect(brief(one)).toEqual(["Kids", null, "Q"]);
    const none = must(await store.update(a.owner, "projects", id, patch({ whoFor: null, openQuestions: null }))).record;
    expect(brief(none)).toEqual([null, null, null]);
  });

  it("refuses a value over 2000 characters and takes exactly 2000", () => {
    for (const key of ["whoFor", "doneLooks", "openQuestions"]) {
      expect(parsePatch("projects", { [key]: "x".repeat(2001) }).ok, `patch ${key}`).toBe(false);
      expect(parseCreate("projects", { ventureId: "v", name: "x", [key]: "x".repeat(2001) }).ok, `create ${key}`).toBe(false);
      expect(parsePatch("projects", { [key]: "x".repeat(2000) }).ok, `patch ${key} at limit`).toBe(true);
      expect(parsePatch("projects", { [key]: 5 }).ok, `patch ${key} number`).toBe(false);
    }
  });

  it("keeps one account's brief from another's", async () => {
    const a = await account();
    const b = await account();
    const id = crypto.randomUUID();
    must(await store.create(a.owner, "projects", create({ id, ventureId: a.venture, name: "Mine", whoFor: "Me" })));
    expect(await store.get(b.owner, "projects", id)).toBeNull();
    expect((await store.update(b.owner, "projects", id, patch({ whoFor: null }))).ok).toBe(false);
    expect((await store.tree(b.owner)).ventures[0]!.projects).toEqual([]);
    expect((await store.get(a.owner, "projects", id))?.whoFor).toBe("Me");
  });
});
