import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SEARCH_KINDS } from "@vemi/shared";
import { hashPassword } from "./password.js";
import { openStore, type Outcome, type Store } from "./store.js";
import { testDb, type TestDb } from "./testing/d1.js";
import { parseCreate } from "./validate.js";

/**
 * Search finds a project by its brief (description, who it is for, what done looks like, open
 * questions) as well as its name, lists it by its name, ranks a name match first, leaves
 * archived projects out, never reads another account's text, and stays quick on a big account.
 */

const PASSWORD = "a long enough password";
const NOW = new Date("2026-11-18T02:00:00Z");
const T = "2026-01-01T00:00:00.000Z";

function must<V>(outcome: Outcome<V>): V {
  if (!outcome.ok) throw new Error(`${outcome.status}: ${outcome.error}`);
  return outcome.value;
}

describe("search over a project's brief", () => {
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
  async function project(a: { owner: string; venture: string }, body: Record<string, unknown>): Promise<string> {
    const id = crypto.randomUUID();
    const parsed = parseCreate("projects", { id, ventureId: a.venture, ...body });
    if (!parsed.ok) throw new Error(parsed.error);
    must(await store.create(a.owner, "projects", parsed.value));
    return id;
  }
  const projectHits = async (owner: string, q: string) =>
    (await store.search(owner, q)).filter((h) => h.kind === "project");

  it("finds a project by each brief field and lists it by its name", async () => {
    const a = await account();
    const id = await project(a, {
      name: "Quiet name", description: "zebrafield one", whoFor: "zebrafield two",
      doneLooks: "zebrafield three", openQuestions: "zebrafield four",
    });
    for (const word of ["zebrafield one", "zebrafield two", "zebrafield three", "zebrafield four"]) {
      const hits = await projectHits(a.owner, word);
      expect(hits.map((h) => h.id), word).toEqual([id]);
      expect(hits[0]!.text).toBe("Quiet name");
      expect(hits[0]!.ventureId).toBe(a.venture);
      expect(hits[0]!.projectId).toBe(id);
    }
  });

  it("matches a brief word case blind and treats % and _ as plain characters", async () => {
    const a = await account();
    const id = await project(a, { name: "Plain", whoFor: "Fifty% of Small_Shops" });
    expect((await projectHits(a.owner, "SMALL_shops")).map((h) => h.id)).toEqual([id]);
    expect((await projectHits(a.owner, "50%")).length).toBe(0);
    expect((await projectHits(a.owner, "Fifty%")).map((h) => h.id)).toEqual([id]);
    expect((await projectHits(a.owner, "Small Shops")).length).toBe(0);
  });

  it("ranks a name match above a brief match, then starts-with, then A to Z", async () => {
    const a = await account();
    const brief = await project(a, { name: "Aardvark", description: "about the harbour" });
    const inName = await project(a, { name: "The harbour" });
    const starts = await project(a, { name: "Harbour first" });
    const hits = await projectHits(a.owner, "harbour");
    expect(hits.map((h) => h.id)).toEqual([starts, inName, brief]);
  });

  it("leaves an archived project out, and brings it back when restored", async () => {
    const a = await account();
    const id = await project(a, { name: "Gone", description: "quokka habitat" });
    expect((await projectHits(a.owner, "quokka")).length).toBe(1);
    must(await store.setArchived(a.owner, "projects", id, true));
    expect((await projectHits(a.owner, "quokka")).length).toBe(0);
    must(await store.setArchived(a.owner, "projects", id, false));
    expect((await projectHits(a.owner, "quokka")).length).toBe(1);
  });

  it("never finds another account's brief", async () => {
    const mine = await account();
    const theirs = await account();
    await project(theirs, { name: "Theirs", description: "narwhalsecret", whoFor: "narwhalsecret", doneLooks: "narwhalsecret", openQuestions: "narwhalsecret" });
    expect(await store.search(mine.owner, "narwhalsecret")).toEqual([]);
    expect((await projectHits(theirs.owner, "narwhalsecret")).length).toBe(1);
  });

  it("keeps the kinds and the caps", async () => {
    const a = await account();
    for (let i = 0; i < 20; i++) await project(a, { name: `P${String(i).padStart(2, "0")}`, description: "capword" });
    const hits = await store.search(a.owner, "capword");
    expect(hits.length).toBe(15);
    expect(new Set(hits.map((h) => h.kind))).toEqual(new Set(["project"]));
    expect([...SEARCH_KINDS]).toEqual(["venture", "project", "milestone", "task", "decision", "risk", "note", "link"]);
  });

  it("times a search with 2,000 tasks, 200 projects and 1,000 notes", async () => {
    const a = await account();
    const db = t.db;
    // One statement a table: rows come from a counting CTE, so seeding is not the cost.
    const count = (n: number) => `WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ${n - 1})`;
    await db.prepare(
      `${count(200)} INSERT INTO project (id, owner, venture_id, name, position, description, who_for, done_looks, open_questions, created_at, updated_at)
       SELECT 'bp' || i, ?1, ?2, 'Project ' || i, i + 1, 'Describes thing ' || i, 'People ' || i, 'Done ' || i, 'Why ' || i, ?3, ?3 FROM n`,
    ).bind(a.owner, a.venture, T).run();
    await db.prepare(
      `${count(2000)} INSERT INTO task (id, owner, venture_id, project_id, title, body, position, created_at, updated_at)
       SELECT 'bt' || i, ?1, ?2, 'bp' || (i % 200), 'Task ' || i || ' about things', 'Body text ' || i, i + 1, ?3, ?3 FROM n`,
    ).bind(a.owner, a.venture, T).run();
    await db.prepare(
      `${count(1000)} INSERT INTO note (id, owner, project_id, body, created_at, updated_at)
       SELECT 'bn' || i, ?1, 'bp' || (i % 200), 'Note ' || i || ' with some words in it', ?2, ?2 FROM n`,
    ).bind(a.owner, T).run();
    const times: number[] = [];
    for (let i = 0; i < 5; i++) {
      const start = performance.now();
      const hits = await store.search(a.owner, "thing");
      times.push(performance.now() - start);
      expect(hits.length).toBeGreaterThan(0);
    }
    // Recorded only: the local D1 harness costs about 46 ms a statement; 150 ms is judged on staging.
    console.log(`search timing ms, no pass line (5 runs, 2000 tasks, 200 projects, 1000 notes): ${times.map((x) => x.toFixed(1)).join(", ")}`);
  });
});
