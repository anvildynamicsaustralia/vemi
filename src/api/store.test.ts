import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getPlatformProxy } from "wrangler";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KINDS, type Kind } from "@vemi/shared";
import { EXPORT_EXCLUDED, openStore, type Outcome, type Store } from "./store.js";
import { parseCreate } from "./validate.js";
import { API_ROOT, migrationStatements, testDb, type TestDb } from "./testing/d1.js";

/**
 * The model against a real D1. One database for the file, one owner per test: owners are
 * what isolate records, so a fresh owner is a fresh database as far as every query knows.
 */

let t: TestDb;
let store: Store;
let owner: string;

beforeAll(async () => {
  t = await testDb();
  store = openStore({ DB: t.db }, () => new Date("2026-09-14T02:00:00Z"));
});
afterAll(() => t.dispose());
beforeEach(() => {
  owner = `owner-${crypto.randomUUID()}`;
});

function must<T>(outcome: Outcome<T>): T {
  if (!outcome.ok) throw new Error(`${outcome.status}: ${outcome.error}`);
  return outcome.value;
}

const venture = async (name: string, extra: Record<string, unknown> = {}) =>
  must(await store.create(owner, "ventures", { name, ...extra })).record;

const task = async (ventureId: string, title: string, extra: Record<string, unknown> = {}) =>
  must(await store.create(owner, "tasks", { ventureId, title, ...extra })).record;

const statesOf = async (ventureId: string) => must(await store.list(owner, "states", { venture: ventureId }));

const stateOfKind = async (ventureId: string, kind: string) => {
  const found = (await statesOf(ventureId)).find((s) => s.kind === kind);
  if (found === undefined) throw new Error(`no ${kind} state`);
  return found;
};

describe("a venture", () => {
  it("is created with a description and a default set of named states, which it can rename and add to", async () => {
    const v = await venture("Black Dingo Studios", { description: "Ship a vertical slice." });
    expect(v.description).toBe("Ship a vertical slice.");

    const states = await statesOf(v.id);
    expect(states.map((s) => [s.name, s.kind])).toEqual([
      ["to do", "not_started"], ["doing", "underway"], ["done", "finished"],
    ]);

    const doing = await stateOfKind(v.id, "underway");
    must(await store.update(owner, "states", doing.id, { name: "blockout" }));
    must(await store.create(owner, "states", { ventureId: v.id, name: "polish", kind: "underway" }));
    expect((await statesOf(v.id)).map((s) => s.name)).toEqual(["to do", "blockout", "done", "polish"]);
  });

  it("counts archived ventures in the overview, even when none is visible", async () => {
    expect((await store.overview(owner)).archivedVentures).toBe(0);

    const only = await venture("Only");
    must(await store.setArchived(owner, "ventures", only.id, true));
    const afterOnly = await store.overview(owner);
    expect(afterOnly.ventures).toEqual([]);
    expect(afterOnly.archivedVentures).toBe(1);

    const parent = await venture("Parent");
    const child = await venture("Child", { parentId: parent.id });
    expect((await store.overview(owner)).archivedVentures).toBe(1);
    must(await store.setArchived(owner, "ventures", child.id, true));
    expect((await store.overview(owner)).archivedVentures).toBe(2);

    must(await store.setArchived(owner, "ventures", only.id, false));
    expect((await store.overview(owner)).archivedVentures).toBe(1);
  });

  it("is archived out of every view and restored by unarchiving", async () => {
    const v = await venture("Career");
    must(await store.setArchived(owner, "ventures", v.id, true));

    expect((await store.overview(owner)).ventures).toEqual([]);
    expect((await store.tree(owner)).ventures).toEqual([]);
    expect(must(await store.list(owner, "ventures", {}))).toEqual([]);
    expect((await store.search(owner, "Career"))).toEqual([]);
    expect((await store.get(owner, "ventures", v.id))?.archivedAt).not.toBeNull();
    expect((await store.archived(owner)).map((a) => a.id)).toEqual([v.id]);

    must(await store.setArchived(owner, "ventures", v.id, false));
    expect((await store.overview(owner)).ventures.map((o) => o.id)).toEqual([v.id]);
  });

  it("belongs to its owner and to nobody else", async () => {
    const v = await venture("The farm");
    expect(await store.get("someone-else", "ventures", v.id)).toBeNull();
    expect((await store.overview("someone-else")).ventures).toEqual([]);
    const refused = await store.create("someone-else", "tasks", { ventureId: v.id, title: "Mine now" });
    expect(refused).toMatchObject({ ok: false, status: 404 });
  });
});

describe("nesting", () => {
  it("lets a venture own ventures, and refuses a third level in the data layer", async () => {
    const holdings = await venture("Holdings");
    const studios = await venture("Studios", { parentId: holdings.id });
    expect(studios.parentId).toBe(holdings.id);

    const third = await store.create(owner, "ventures", { name: "A studio's studio", parentId: studios.id });
    expect(third).toMatchObject({ ok: false, status: 409 });
    expect(!third.ok && third.error).toContain("two levels");

    const loose = await venture("Loose");
    const under = await store.update(owner, "ventures", loose.id, { parentId: studios.id });
    expect(under).toMatchObject({ ok: false, status: 409 });
  });

  it("refuses to give a parent to a venture that already owns ventures", async () => {
    const holdings = await venture("Holdings");
    await venture("Studios", { parentId: holdings.id });
    const group = await venture("Group");
    const refused = await store.update(owner, "ventures", holdings.id, { parentId: group.id });
    expect(refused).toMatchObject({ ok: false, status: 409 });
    expect(!refused.ok && refused.error).toContain("has ventures of its own");
  });

  it("counts an archived child as a child, so unarchiving it cannot make a third level", async () => {
    const holdings = await venture("Holdings");
    const studios = await venture("Studios", { parentId: holdings.id });
    must(await store.setArchived(owner, "ventures", studios.id, true));
    const group = await venture("Group");
    expect(await store.update(owner, "ventures", holdings.id, { parentId: group.id })).toMatchObject({ ok: false, status: 409 });
  });

  it("refuses a venture as its own parent", async () => {
    const v = await venture("Self");
    expect(await store.update(owner, "ventures", v.id, { parentId: v.id })).toMatchObject({ ok: false });
  });
});


describe("projects inside projects", () => {
  const project = async (ventureId: string, name: string, extra: Record<string, unknown> = {}) =>
    must(await store.create(owner, "projects", { ventureId, name, ...extra })).record;
  const archive = async (kind: Kind, id: string) => must(await store.setArchived(owner, kind, id, true));
  const restore = async (kind: Kind, id: string) => must(await store.setArchived(owner, kind, id, false));
  const refusedWith = (outcome: Outcome<unknown>, status: number, words: string) => {
    expect(outcome).toMatchObject({ ok: false, status });
    expect(!outcome.ok && outcome.error).toContain(words);
  };
  /** Everything a refusal must leave alone. */
  const held = async () => ({
    projects: must(await store.list(owner, "projects", {})),
    tasks: must(await store.list(owner, "tasks", {})),
  });

  it("takes a parent on create and on update, and gives it up again", async () => {
    const v = await venture("Studio");
    const parent = await project(v.id, "Launch");
    const child = await project(v.id, "Trailer", { parentId: parent.id });
    expect(child.parentId).toBe(parent.id);
    expect(parent.parentId).toBeNull();
    expect(must(await store.list(owner, "projects", { parent: parent.id })).map((p) => p.id)).toEqual([child.id]);
    const late = await project(v.id, "Poster");
    expect(late.parentId).toBeNull();
    expect(must(await store.update(owner, "projects", late.id, { parentId: parent.id })).record.parentId).toBe(parent.id);
    expect(must(await store.update(owner, "projects", late.id, { parentId: null })).record.parentId).toBeNull();
  });

  it("refuses a third level on create and on update, and writes nothing", async () => {
    const v = await venture("Studio");
    const parent = await project(v.id, "Launch");
    const child = await project(v.id, "Trailer", { parentId: parent.id });
    const loose = await project(v.id, "Loose");
    const before = await held();

    refusedWith(await store.create(owner, "projects", { ventureId: v.id, name: "Cut", parentId: child.id }), 409, "one level");
    refusedWith(await store.update(owner, "projects", loose.id, { parentId: child.id }), 409, "one level");
    expect(await held()).toEqual(before);
  });

  it("refuses a parent to a project that holds projects, an archived one included", async () => {
    const v = await venture("Studio");
    const parent = await project(v.id, "Launch");
    const child = await project(v.id, "Trailer", { parentId: parent.id });
    const group = await project(v.id, "Group");

    refusedWith(await store.update(owner, "projects", parent.id, { parentId: group.id }), 409, "holds projects of its own");
    await archive("projects", child.id);
    const before = await held();
    refusedWith(await store.update(owner, "projects", parent.id, { parentId: group.id }), 409, "holds projects of its own");
    expect(await held()).toEqual(before);
  });

  it("refuses a project as its own parent", async () => {
    const v = await venture("Studio");
    const p = await project(v.id, "Launch");
    const before = await held();
    refusedWith(await store.update(owner, "projects", p.id, { parentId: p.id }), 409, "inside itself");
    expect(await held()).toEqual(before);
  });

  it("refuses a parent in another venture", async () => {
    const v = await venture("Studio");
    const other = await venture("Farm");
    const abroad = await project(other.id, "Abroad");
    const p = await project(v.id, "Launch");
    const before = await held();
    refusedWith(await store.create(owner, "projects", { ventureId: v.id, name: "X", parentId: abroad.id }), 404, "not found in venture");
    refusedWith(await store.update(owner, "projects", p.id, { parentId: abroad.id }), 404, "not found in venture");
    expect(await held()).toEqual(before);
  });

  it("refuses a parent to a stranger, and writes nothing", async () => {
    const v = await venture("Studio");
    const p = await project(v.id, "Launch");
    const before = await held();
    expect(await store.create("someone-else", "projects", { ventureId: v.id, name: "Z", parentId: p.id }))
      .toMatchObject({ ok: false });
    expect(await held()).toEqual(before);
  });

  it("refuses an archived parent, and a parent under an archived venture", async () => {
    const v = await venture("Studio");
    const gone = await project(v.id, "Gone");
    const p = await project(v.id, "Launch");
    await archive("projects", gone.id);
    const before = await held();
    refusedWith(await store.create(owner, "projects", { ventureId: v.id, name: "X", parentId: gone.id }), 404, "not found in venture");
    refusedWith(await store.update(owner, "projects", p.id, { parentId: gone.id }), 404, "not found in venture");
    expect(await held()).toEqual(before);

    const w = await venture("Closed");
    const up = await project(w.id, "Up");
    const down = await project(w.id, "Down");
    await archive("ventures", w.id);
    expect(await store.update(owner, "projects", down.id, { parentId: up.id })).toMatchObject({ ok: false });
    expect(await store.create(owner, "projects", { ventureId: w.id, name: "Y", parentId: up.id })).toMatchObject({ ok: false });
    expect((await store.get(owner, "projects", down.id))?.parentId).toBeNull();
  });

  it("hides a child and all it holds when its parent is archived, and brings every bit back unchanged", async () => {
    const v = await venture("Studio");
    const parent = await project(v.id, "Launch");
    const child = await project(v.id, "Trailer", { parentId: parent.id });
    const milestone = must(await store.create(owner, "milestones", { projectId: child.id, name: "Locked", aimingOn: "2026-11-01" })).record;
    const inside = await task(v.id, "Cut it", { projectId: child.id, milestoneId: milestone.id, pickedOn: "2026-10-15" });
    must(await store.create(owner, "notes", { projectId: child.id, body: "Trailer notes" }));
    must(await store.create(owner, "decisions", { projectId: child.id, title: "Trailer decision" }));
    must(await store.create(owner, "risks", { projectId: child.id, title: "Trailer risk" }));
    must(await store.create(owner, "links", { projectId: child.id, url: "https://example.com/trailer" }));

    const seen = async () => ({
      tree: await store.tree(owner),
      overview: await store.overview(owner),
      today: await store.today(owner, "2026-10-15"),
      search: await store.search(owner, "Trailer"),
      lists: await Promise.all((["projects", "milestones", "tasks", "notes", "decisions", "risks", "links"] as const)
        .map(async (k) => must(await store.list(owner, k, {})))),
    });
    const before = await seen();
    expect(before.today.tasks.map((x) => x.id)).toEqual([inside.id]);
    expect(before.search.length).toBeGreaterThan(0);
    expect(before.lists.every((l) => l.length > 0)).toBe(true);

    await archive("projects", parent.id);
    const hidden = await seen();
    expect(hidden.tree.ventures[0]?.projects).toEqual([]);
    expect(hidden.today.tasks).toEqual([]);
    expect(hidden.search).toEqual([]);
    expect(hidden.lists.every((l) => l.length === 0)).toBe(true);
    expect(hidden.overview.ventures[0]?.own).toMatchObject({ tasksLeft: 0, underway: 0 });
    expect(hidden.overview.ventures[0]?.own.nextMilestone).toBeNull();

    await restore("projects", parent.id);
    expect(await seen()).toEqual(before);
  });

  it("refuses a task in a child whose parent is archived", async () => {
    const v = await venture("Studio");
    const parent = await project(v.id, "Launch");
    const child = await project(v.id, "Trailer", { parentId: parent.id });
    await archive("projects", parent.id);
    const before = await held();
    expect(await store.create(owner, "tasks", { ventureId: v.id, title: "More", projectId: child.id }))
      .toMatchObject({ ok: false, status: 400 });
    expect(await held()).toEqual(before);
  });

  it("moves a parent to another venture with its children, archived ones included, and their work", async () => {
    const a = await venture("A");
    const b = await venture("B");
    const parent = await project(a.id, "Launch");
    const child = await project(a.id, "Trailer", { parentId: parent.id });
    const old = await project(a.id, "Old", { parentId: parent.id });
    const doing = await stateOfKind(a.id, "underway");
    const milestone = must(await store.create(owner, "milestones", { projectId: child.id, name: "Locked", stateId: doing.id })).record;
    const inside = await task(a.id, "Cut it", { projectId: child.id, stateId: doing.id });
    const oldTask = await task(a.id, "Shelve it", { projectId: old.id });
    const stage = must(await store.list(owner, "stages", { venture: a.id }))[3];
    if (stage === undefined) throw new Error("no stage");
    must(await store.update(owner, "projects", child.id, { stageId: stage.id }));
    await archive("projects", old.id);

    must(await store.update(owner, "projects", parent.id, { ventureId: b.id }));

    const doingB = await stateOfKind(b.id, "underway");
    expect(must(await store.list(owner, "projects", { venture: b.id })).map((p) => p.name).sort()).toEqual(["Launch", "Trailer"]);
    expect(await store.get(owner, "projects", child.id)).toMatchObject({ ventureId: b.id, parentId: parent.id });
    expect(await store.get(owner, "projects", old.id)).toMatchObject({ ventureId: b.id, parentId: parent.id });
    expect(await store.get(owner, "tasks", inside.id)).toMatchObject({ ventureId: b.id, stateId: doingB.id });
    expect((await store.get(owner, "tasks", oldTask.id))?.ventureId).toBe(b.id);
    expect((await store.get(owner, "milestones", milestone.id))?.stateId).toBe(doingB.id);
    const landed = (await store.get(owner, "projects", child.id))?.stageId;
    const stagesB = must(await store.list(owner, "stages", { venture: b.id }));
    expect(stagesB.find((s) => s.id === landed)?.kind).toBe(stage.kind);
  });

  it("clears the parent of a child moved alone, and keeps one named in the target venture", async () => {
    const a = await venture("A");
    const b = await venture("B");
    const parent = await project(a.id, "Launch");
    const child = await project(a.id, "Trailer", { parentId: parent.id });
    const inside = await task(a.id, "Cut it", { projectId: child.id });
    const home = await project(b.id, "Home");

    must(await store.update(owner, "projects", child.id, { ventureId: b.id }));
    expect(await store.get(owner, "projects", child.id)).toMatchObject({ ventureId: b.id, parentId: null });
    expect((await store.get(owner, "tasks", inside.id))?.ventureId).toBe(b.id);
    expect((await store.get(owner, "projects", parent.id))?.ventureId).toBe(a.id);

    const second = await project(a.id, "Second", { parentId: parent.id });
    must(await store.update(owner, "projects", second.id, { ventureId: b.id, parentId: home.id }));
    expect(await store.get(owner, "projects", second.id)).toMatchObject({ ventureId: b.id, parentId: home.id });

    const third = await project(a.id, "Third", { parentId: parent.id });
    const refused = await store.update(owner, "projects", third.id, { ventureId: b.id, parentId: parent.id });
    expect(refused).toMatchObject({ ok: false, status: 404 });
    expect(await store.get(owner, "projects", third.id)).toMatchObject({ ventureId: a.id, parentId: parent.id });
  });

  it("makes the parent read as blocked from a child, while its tasks stay its own", async () => {
    const v = await venture("Studio");
    const parent = await project(v.id, "Launch");
    const child = await project(v.id, "Trailer", { parentId: parent.id });
    const mine = await task(v.id, "Plan it", { projectId: parent.id });
    const stuck = await task(v.id, "Cut it", { projectId: child.id });
    must(await store.create(owner, "blockers", { taskId: stuck.id, reason: "waiting on music" }));

    const shown = (await store.tree(owner)).ventures[0]?.projects ?? [];
    const top = shown.find((p) => p.id === parent.id);
    expect(top?.blocked).toBe(true);
    expect(top?.tasks.map((x) => x.id)).toEqual([mine.id]);
    expect(shown.find((p) => p.id === child.id)?.blocked).toBe(true);
    expect(shown.find((p) => p.id === child.id)?.tasks.map((x) => x.id)).toEqual([stuck.id]);
  });

  it("names the projects an archived project holds, and no other kind carries holds", async () => {
    const v = await venture("Studio");
    const parent = await project(v.id, "Launch");
    const live = await project(v.id, "Trailer", { parentId: parent.id });
    const shelved = await project(v.id, "Old", { parentId: parent.id });
    const lone = await project(v.id, "Lone");
    await archive("projects", shelved.id);
    await archive("projects", parent.id);
    await archive("projects", lone.id);
    await archive("tasks", (await task(v.id, "T")).id);

    const items = await store.archived(owner);
    expect([...(items.find((a) => a.id === parent.id)?.holds ?? [])].sort()).toEqual([live.id, shelved.id].sort());
    expect(items.find((a) => a.id === lone.id)?.holds).toEqual([]);
    expect(items.find((a) => a.id === shelved.id)?.holds).toEqual([]);
    expect(items.some((a) => a.kind === "tasks")).toBe(true);
    for (const item of items) if (item.kind !== "projects") expect("holds" in item, item.kind).toBe(false);
  });

  describe("deleting", () => {
    it("counts the parent, every child and everything under them, then destroys exactly that", async () => {
      const v = await venture("Studio");
      const outsider = await venture("Elsewhere");
      const legal = must(await store.create(owner, "tags", { name: "legal" })).record;
      const parent = await project(v.id, "Launch", { tagIds: [legal.id] });
      const child = await project(v.id, "Trailer", { parentId: parent.id, tagIds: [legal.id] });
      const shelved = await project(v.id, "Old", { parentId: parent.id });
      const sibling = await project(v.id, "Keep");

      const m1 = must(await store.create(owner, "milestones", { projectId: parent.id, name: "Plan" })).record;
      const m2 = must(await store.create(owner, "milestones", { projectId: child.id, name: "Locked" })).record;
      const t1 = await task(v.id, "Plan it", { projectId: parent.id, milestoneId: m1.id });
      const t2 = await task(v.id, "Cut it", { projectId: child.id, milestoneId: m2.id, tagIds: [legal.id] });
      const t3 = await task(v.id, "Shelve it", { projectId: shelved.id });
      const kept = await task(v.id, "Untouched", { projectId: sibling.id });
      const b1 = must(await store.create(owner, "blockers", { taskId: t2.id, reason: "music" })).record;
      const l1 = must(await store.create(owner, "links", { projectId: child.id, url: "https://example.com/a" })).record;
      const n1 = must(await store.create(owner, "notes", { projectId: parent.id, body: "Parent note" })).record;
      // Task notes are cut from the app, but their rows stay and still follow their task.
      await t.db.prepare(
        `INSERT INTO note (id, owner, task_id, body, created_at, updated_at) VALUES ('legacy-task-note', ?, ?, 'Child task note', '2026-09-14T02:00:00.000Z', '2026-09-14T02:00:00.000Z')`,
      ).bind(owner, t2.id).run();
      const n2 = { id: "legacy-task-note" };
      const d1 = must(await store.create(owner, "decisions", { projectId: child.id, title: "Cut short" })).record;
      const r1 = must(await store.create(owner, "risks", { projectId: parent.id, title: "Rain" })).record;
      // A blocker elsewhere that waited on a task inside.
      const away = await task(outsider.id, "Waits");
      const waiter = must(await store.create(owner, "blockers", { taskId: away.id, reason: "waiting on Cut it", waitsOnTaskId: t2.id })).record;

      await archive("projects", shelved.id);
      await archive("projects", parent.id);
      const preview = await store.deletePreview(owner, "projects", parent.id);
      const expected = {
        ventures: 0, states: 0, stages: 0, tags: 0,
        projects: 3, milestones: 2, tasks: 3, blockers: 1, notes: 2, decisions: 1, risks: 1, links: 1,
        taskTags: 1, projectTags: 2,
      };
      expect(preview?.refusal).toBeNull();
      expect(preview?.removes).toEqual(expected);

      const done = must(await store.remove(owner, "projects", parent.id, "Launch"));
      expect(done.removes).toEqual(expected);
      for (const [kind, id] of [
        ["projects", parent.id], ["projects", child.id], ["projects", shelved.id],
        ["milestones", m1.id], ["milestones", m2.id], ["tasks", t1.id], ["tasks", t2.id], ["tasks", t3.id],
        ["blockers", b1.id], ["links", l1.id], ["notes", n1.id], ["notes", n2.id], ["decisions", d1.id], ["risks", r1.id],
      ] as const) {
        expect(await store.get(owner, kind, id), `${kind} ${id}`).toBeNull();
      }
      expect(must(await store.list(owner, "projects", { venture: v.id })).map((p) => p.id)).toEqual([sibling.id]);
      expect(await store.get(owner, "projects", sibling.id)).not.toBeNull();
      expect(await store.get(owner, "tasks", kept.id)).not.toBeNull();
      expect(await store.get(owner, "tags", legal.id)).not.toBeNull();
      // The blocker elsewhere is kept and let go.
      const stays = await store.get(owner, "blockers", waiter.id);
      expect(stays).not.toBeNull();
      expect(stays?.waitsOnTaskId).toBeNull();
      expect(await store.get(owner, "tasks", away.id)).not.toBeNull();
    });

    it("leaves the parent standing when an archived child is deleted", async () => {
      const v = await venture("Studio");
      const parent = await project(v.id, "Launch");
      const child = await project(v.id, "Trailer", { parentId: parent.id });
      const mine = await task(v.id, "Plan it", { projectId: parent.id });
      const theirs = await task(v.id, "Cut it", { projectId: child.id });
      await archive("projects", child.id);

      const preview = await store.deletePreview(owner, "projects", child.id);
      expect(preview?.removes).toMatchObject({ projects: 1, tasks: 1 });
      must(await store.remove(owner, "projects", child.id, "Trailer"));
      expect(await store.get(owner, "projects", child.id)).toBeNull();
      expect(await store.get(owner, "tasks", theirs.id)).toBeNull();
      expect(await store.get(owner, "projects", parent.id)).not.toBeNull();
      expect(await store.get(owner, "tasks", mine.id)).not.toBeNull();
    });
  });

  it("still reads the tree and today in one round trip each with a nest in them", async () => {
    const v = await venture("Studio");
    const parent = await project(v.id, "Launch");
    const child = await project(v.id, "Trailer", { parentId: parent.id });
    await task(v.id, "Cut it", { projectId: child.id, pickedOn: "2026-10-15" });
    t.resetCount();
    await store.tree(owner);
    expect(t.queries()).toBe(1);
    t.resetCount();
    await store.today(owner, "2026-10-15");
    expect(t.queries()).toBe(1);
  });
});

describe("the overview", () => {
  it("rolls a parent's four figures up from everything beneath it, in one round trip", async () => {
    const holdings = await venture("Holdings");
    const studios = await venture("Studios", { parentId: holdings.id });

    const hDoing = await stateOfKind(holdings.id, "underway");
    await task(holdings.id, "Book the accountant", { stateId: hDoing.id });
    await task(holdings.id, "Pick a structure");

    const sDoing = await stateOfKind(studios.id, "underway");
    const sDone = await stateOfKind(studios.id, "finished");
    const blocked = await task(studios.id, "Blockout the chase", { stateId: sDoing.id });
    must(await store.create(owner, "blockers", { taskId: blocked.id, reason: "Waiting on Tommy" }));
    await task(studios.id, "Concept art", { stateId: sDone.id });
    await task(studios.id, "Street layout");

    const project = must(await store.create(owner, "projects", { ventureId: studios.id, name: "IP Development" })).record;
    must(await store.create(owner, "milestones", { projectId: project.id, name: "World bible locked", aimingOn: "2026-09-30" }));

    t.resetCount();
    const overview = await store.overview(owner);
    expect(t.queries()).toBe(1);

    const h = overview.ventures.find((v) => v.id === holdings.id);
    const s = overview.ventures.find((v) => v.id === studios.id);
    expect(h?.own).toEqual({ underway: 1, blocked: 0, tasksLeft: 2, nextMilestone: null });
    expect(h?.total).toMatchObject({ underway: 2, blocked: 1, tasksLeft: 4 });
    expect(h?.total.nextMilestone).toMatchObject({ name: "World bible locked", aimingOn: "2026-09-30" });
    expect(s?.own).toEqual(s?.total);
    expect(s?.own).toMatchObject({ underway: 1, blocked: 1, tasksLeft: 2 });
  });

  it("names the next milestone by the date aimed at, finished ones aside", async () => {
    const v = await venture("Network");
    const p = must(await store.create(owner, "projects", { ventureId: v.id, name: "FiveM" })).record;
    const done = await stateOfKind(v.id, "finished");
    must(await store.create(owner, "milestones", { projectId: p.id, name: "Undated" }));
    must(await store.create(owner, "milestones", { projectId: p.id, name: "Later", aimingOn: "2026-11-01" }));
    must(await store.create(owner, "milestones", { projectId: p.id, name: "Sooner", aimingOn: "2026-10-19" }));
    must(await store.create(owner, "milestones", { projectId: p.id, name: "Shipped", aimingOn: "2026-01-01", stateId: done.id }));

    const [row] = (await store.overview(owner)).ventures;
    expect(row?.own.nextMilestone?.name).toBe("Sooner");
  });
});


describe("archiving a parent", () => {
  it("takes its children out of view with it, detaches nothing, and brings them back", async () => {
    const holdings = await venture("Holdings");
    const studios = await venture("Studios", { parentId: holdings.id });
    await task(studios.id, "Due work", { dueOn: "2026-09-01" });

    must(await store.setArchived(owner, "ventures", holdings.id, true));
    expect((await store.overview(owner)).ventures).toEqual([]);
    expect((await store.today(owner, "2026-09-14")).tasks).toEqual([]);
    expect((await store.get(owner, "ventures", studios.id))?.parentId).toBe(holdings.id);
    expect((await store.get(owner, "ventures", studios.id))?.archivedAt).toBeNull();

    must(await store.setArchived(owner, "ventures", holdings.id, false));
    const back = await store.overview(owner);
    expect(back.ventures.find((v) => v.id === studios.id)?.parentId).toBe(holdings.id);
    expect((await store.today(owner, "2026-09-14")).tasks).toHaveLength(1);
  });
});

describe("a task", () => {
  it("is valid with a title and a venture alone, and carries no icon", async () => {
    const v = await venture("Personal");
    const created = await task(v.id, "Renew the licence");
    expect(created).toMatchObject({
      title: "Renew the licence", ventureId: v.id, projectId: null, milestoneId: null, stateId: null,
      body: null, checklist: [], priority: null, dueOn: null, pickedOn: null, archivedAt: null,
    });
    expect(created).not.toHaveProperty("icon");
    expect(created).not.toHaveProperty("size");
    expect((await store.overview(owner)).ventures[0]?.own.tasksLeft).toBe(1);
  });

  it("can carry a blocker in any state, and its project and venture report something blocked", async () => {
    const v = await venture("Studios");
    const p = must(await store.create(owner, "projects", { ventureId: v.id, name: "Slice" })).record;
    const states = await statesOf(v.id);
    for (const state of states) {
      const inState = await task(v.id, `In ${state.name}`, { stateId: state.id, projectId: p.id });
      must(await store.create(owner, "blockers", { taskId: inState.id, reason: "Waiting", person: "Tommy" }));
    }
    // The finished one keeps its blocker but no longer counts: nothing waits on done work.
    expect((await store.overview(owner)).ventures[0]?.own.blocked).toBe(states.filter((s) => s.kind !== "finished").length);

    const tree = await store.tree(owner);
    expect(tree.ventures[0]?.blocked).toBe(true);
    expect(tree.ventures[0]?.projects[0]?.blocked).toBe(true);
    expect(tree.ventures[0]?.projects[0]?.tasks.every((x) => x.blocker?.reason === "Waiting")).toBe(true);
  });

  it("stops counting as blocked once it is finished, and keeps its blocker", async () => {
    const holdings = await venture("Holdings");
    const v = await venture("Studios", { parentId: holdings.id });
    const p = must(await store.create(owner, "projects", { ventureId: v.id, name: "Slice" })).record;
    const m = must(await store.create(owner, "milestones", { projectId: p.id, name: "Slice done" })).record;
    const x = await task(v.id, "Chase", { projectId: p.id, milestoneId: m.id });
    const blocker = must(await store.create(owner, "blockers", { taskId: x.id, reason: "Waiting on Tommy" })).record;

    const blockedIn = async () => {
      const overview = await store.overview(owner);
      const tree = await store.tree(owner);
      const studios = tree.ventures.find((tv) => tv.id === v.id);
      return {
        own: overview.ventures.find((o) => o.id === v.id)?.own.blocked,
        total: overview.ventures.find((o) => o.id === holdings.id)?.total.blocked,
        holdings: tree.ventures.find((tv) => tv.id === holdings.id)?.blocked,
        venture: studios?.blocked,
        project: studios?.projects[0]?.blocked,
        milestone: studios?.projects[0]?.milestones[0]?.blocked,
      };
    };
    expect(await blockedIn()).toEqual({ own: 1, total: 1, holdings: true, venture: true, project: true, milestone: true });

    must(await store.update(owner, "tasks", x.id, { stateId: (await stateOfKind(v.id, "finished")).id }));
    expect(await blockedIn()).toEqual({ own: 0, total: 0, holdings: false, venture: false, project: false, milestone: false });
    expect((await store.get(owner, "blockers", blocker.id))?.archivedAt).toBeNull();
    expect((await store.tree(owner)).ventures.find((tv) => tv.id === v.id)?.projects[0]?.tasks[0]?.blocker?.id).toBe(blocker.id);

    must(await store.update(owner, "tasks", x.id, { stateId: (await stateOfKind(v.id, "underway")).id }));
    expect((await blockedIn()).own).toBe(1);
  });

  it("carries one blocker at a time, and clearing it is archiving it", async () => {
    const v = await venture("Studios");
    const x = await task(v.id, "Chase");
    const blocker = must(await store.create(owner, "blockers", { taskId: x.id, reason: "Art" })).record;
    expect(await store.create(owner, "blockers", { taskId: x.id, reason: "Again" })).toMatchObject({ ok: false, status: 409 });

    must(await store.setArchived(owner, "blockers", blocker.id, true));
    expect((await store.overview(owner)).ventures[0]?.own.blocked).toBe(0);
    must(await store.setArchived(owner, "blockers", blocker.id, false));
    expect((await store.overview(owner)).ventures[0]?.own.blocked).toBe(1);
  });

  it("refuses a milestone from another project and a state from another venture", async () => {
    const v = await venture("Studios");
    const other = await venture("Farm");
    const p1 = must(await store.create(owner, "projects", { ventureId: v.id, name: "One" })).record;
    const p2 = must(await store.create(owner, "projects", { ventureId: v.id, name: "Two" })).record;
    const m2 = must(await store.create(owner, "milestones", { projectId: p2.id, name: "Two's" })).record;
    const foreign = await stateOfKind(other.id, "underway");

    expect(await store.create(owner, "tasks", { ventureId: v.id, title: "x", projectId: p1.id, milestoneId: m2.id }))
      .toMatchObject({ ok: false, status: 400 });
    expect(await store.create(owner, "tasks", { ventureId: v.id, title: "x", stateId: foreign.id }))
      .toMatchObject({ ok: false, status: 400 });

    const inferred = await task(v.id, "Takes its project from its milestone", { milestoneId: m2.id });
    expect(inferred.projectId).toBe(p2.id);
  });

  it("moves to another venture into the first state of the same kind", async () => {
    const from = await venture("Studios");
    const to = await venture("Network");
    const doing = await stateOfKind(from.id, "underway");
    must(await store.create(owner, "states", { ventureId: to.id, name: "building", kind: "underway", position: 0 }));
    const p = must(await store.create(owner, "projects", { ventureId: from.id, name: "Slice" })).record;
    const x = await task(from.id, "Server list", { stateId: doing.id, projectId: p.id });

    const moved = must(await store.update(owner, "tasks", x.id, { ventureId: to.id })).record;
    expect(moved.ventureId).toBe(to.id);
    expect(moved.projectId).toBeNull();
    const landed = (await statesOf(to.id)).find((s) => s.id === moved.stateId);
    expect(landed?.name).toBe("building");
  });

  it("comes back from another venture with its project, milestone and state, as undo sends them", async () => {
    // The shape the task sheet's undo sends (src/web/ventureMove.ts): every field the
    // move rewrote, as it was before. A second state of the same kind is the case that a
    // way back naming the venture alone would land in the wrong column.
    const from = await venture("Studios");
    const to = await venture("Network");
    const review = must(await store.create(owner, "states", { ventureId: from.id, name: "review", kind: "underway", position: 9 })).record;
    const p = must(await store.create(owner, "projects", { ventureId: from.id, name: "Slice" })).record;
    const m = must(await store.create(owner, "milestones", { projectId: p.id, name: "Slice done" })).record;
    const x = await task(from.id, "Server list", { stateId: review.id, projectId: p.id, milestoneId: m.id });

    const moved = must(await store.update(owner, "tasks", x.id, { ventureId: to.id })).record;
    expect(moved).toMatchObject({ ventureId: to.id, projectId: null, milestoneId: null });
    expect(moved.stateId).not.toBe(review.id);

    const back = must(await store.update(owner, "tasks", x.id, {
      ventureId: from.id, projectId: p.id, milestoneId: m.id, stateId: review.id,
    })).record;
    expect(back).toMatchObject({ ventureId: from.id, projectId: p.id, milestoneId: m.id, stateId: review.id });
  });

  it("moves with its project when the project moves", async () => {
    const from = await venture("Studios");
    const to = await venture("Dynamics");
    const done = await stateOfKind(from.id, "finished");
    const p = must(await store.create(owner, "projects", { ventureId: from.id, name: "Anvil" })).record;
    const x = await task(from.id, "Dogfood", { projectId: p.id, stateId: done.id });

    must(await store.update(owner, "projects", p.id, { ventureId: to.id }));
    const after = await store.get(owner, "tasks", x.id);
    expect(after?.ventureId).toBe(to.id);
    expect(after?.stateId).toBe((await stateOfKind(to.id, "finished")).id);
  });
});

describe("a state", () => {
  it("cannot be archived while a task sits in it", async () => {
    const v = await venture("Farm");
    const doing = await stateOfKind(v.id, "underway");
    const x = await task(v.id, "Strainers", { stateId: doing.id });
    expect(await store.setArchived(owner, "states", doing.id, true)).toMatchObject({ ok: false, status: 409 });
    must(await store.update(owner, "tasks", x.id, { stateId: null }));
    must(await store.setArchived(owner, "states", doing.id, true));
  });
});

const stagesOf = async (ventureId: string) => must(await store.list(owner, "stages", { venture: ventureId }));

const stageOfKind = async (ventureId: string, kind: string) => {
  const found = (await stagesOf(ventureId)).find((s) => s.kind === kind);
  if (found === undefined) throw new Error(`no ${kind} stage`);
  return found;
};

describe("a lifecycle stage", () => {
  it("comes five to a venture, in order, and a venture or project starts with none set and not at risk", async () => {
    const v = await venture("Farm");
    expect((await stagesOf(v.id)).map((s) => [s.name, s.kind])).toEqual([
      ["Idea", "early"], ["Building", "active"], ["Live", "shipped"], ["Paused", "paused"], ["Stopped", "stopped"],
    ]);
    const p = must(await store.create(owner, "projects", { ventureId: v.id, name: "Slice" })).record;
    expect([v.stageId, v.atRisk, p.stageId, p.atRisk]).toEqual([null, false, null, false]);
  });

  it("is set on a venture and a project by a patch, and only from that venture's own live stages", async () => {
    const v = await venture("Farm");
    const other = await venture("Mill");
    const p = must(await store.create(owner, "projects", { ventureId: v.id, name: "Slice" })).record;
    const building = (await stagesOf(v.id)).find((s) => s.name === "Building");
    const foreign = (await stagesOf(other.id))[0];
    if (building === undefined || foreign === undefined) throw new Error("stages missing");

    expect(await store.update(owner, "ventures", v.id, { stageId: foreign.id })).toMatchObject({ ok: false, status: 400 });
    expect(await store.update(owner, "projects", p.id, { stageId: foreign.id })).toMatchObject({ ok: false, status: 400 });
    expect(must(await store.update(owner, "ventures", v.id, { stageId: building.id })).record.stageId).toBe(building.id);
    expect(must(await store.update(owner, "projects", p.id, { stageId: building.id })).record.stageId).toBe(building.id);
    expect(must(await store.update(owner, "projects", p.id, { stageId: null })).record.stageId).toBeNull();
  });

  it("sets at risk by hand on a venture and a project, and clears it", async () => {
    const v = await venture("Farm");
    const p = must(await store.create(owner, "projects", { ventureId: v.id, name: "Slice" })).record;
    expect(must(await store.update(owner, "ventures", v.id, { atRisk: true })).record.atRisk).toBe(true);
    expect(must(await store.update(owner, "projects", p.id, { atRisk: true })).record.atRisk).toBe(true);
    expect(must(await store.update(owner, "projects", p.id, { atRisk: false })).record.atRisk).toBe(false);
  });

  it("goes with a moved project to the target's first stage of the same kind", async () => {
    const from = await venture("Farm");
    const to = await venture("Mill");
    const p = must(await store.create(owner, "projects", { ventureId: from.id, name: "Slice" })).record;
    must(await store.update(owner, "projects", p.id, { stageId: (await stageOfKind(from.id, "shipped")).id }));
    const moved = must(await store.update(owner, "projects", p.id, { ventureId: to.id })).record;
    expect(moved.stageId).toBe((await stageOfKind(to.id, "shipped")).id);
  });

  it("cannot be archived while a live venture sits at it", async () => {
    const v = await venture("Farm");
    const early = await stageOfKind(v.id, "early");
    must(await store.update(owner, "ventures", v.id, { stageId: early.id }));
    expect(await store.setArchived(owner, "stages", early.id, true)).toMatchObject({ ok: false, status: 409 });
    must(await store.update(owner, "ventures", v.id, { stageId: null }));
    must(await store.setArchived(owner, "stages", early.id, true));
  });

  it("cannot be archived while a live project sits at it", async () => {
    const v = await venture("Farm");
    const p = must(await store.create(owner, "projects", { ventureId: v.id, name: "Slice" })).record;
    const early = await stageOfKind(v.id, "early");
    must(await store.update(owner, "projects", p.id, { stageId: early.id }));
    expect(await store.setArchived(owner, "stages", early.id, true)).toMatchObject({ ok: false, status: 409 });
    must(await store.update(owner, "projects", p.id, { stageId: null }));
    must(await store.setArchived(owner, "stages", early.id, true));
  });

  it("is not held by an archived project at it", async () => {
    const v = await venture("Farm");
    const p = must(await store.create(owner, "projects", { ventureId: v.id, name: "Slice" })).record;
    const early = await stageOfKind(v.id, "early");
    must(await store.update(owner, "projects", p.id, { stageId: early.id }));
    must(await store.setArchived(owner, "projects", p.id, true));
    must(await store.setArchived(owner, "stages", early.id, true));
  });

  it("is not held by an archived venture at it", async () => {
    const v = await venture("Farm");
    const early = await stageOfKind(v.id, "early");
    must(await store.update(owner, "ventures", v.id, { stageId: early.id }));
    must(await store.setArchived(owner, "ventures", v.id, true));
    must(await store.setArchived(owner, "stages", early.id, true));
  });
});

describe("where a stage may be pointed, mapped and removed", () => {
  const setup = async () => {
    const v = await venture("Farm");
    const other = await venture("Mill");
    const p = must(await store.create(owner, "projects", { ventureId: v.id, name: "Slice" })).record;
    return { v, other, p };
  };

  it("refuses an archived stage, and another owner's, for a venture and for a project", async () => {
    const { v, p } = await setup();
    const spare = (await stagesOf(v.id)).find((s) => s.name === "Paused");
    if (spare === undefined) throw new Error("no Paused");
    must(await store.setArchived(owner, "stages", spare.id, true));
    expect(await store.update(owner, "ventures", v.id, { stageId: spare.id })).toMatchObject({ ok: false, status: 400 });
    expect(await store.update(owner, "projects", p.id, { stageId: spare.id })).toMatchObject({ ok: false, status: 400 });

    const stranger = `owner-${crypto.randomUUID()}`;
    const theirs = must(await store.create(stranger, "ventures", { name: "Theirs" })).record;
    const theirStage = must(await store.list(stranger, "stages", { venture: theirs.id }))[0];
    if (theirStage === undefined) throw new Error("no stage");
    expect(await store.update(owner, "ventures", v.id, { stageId: theirStage.id })).toMatchObject({ ok: false, status: 400 });
    expect(await store.update(owner, "projects", p.id, { stageId: theirStage.id })).toMatchObject({ ok: false, status: 400 });
  });

  it("gives a moved project none when the target has no live stage of its kind", async () => {
    const { v, other, p } = await setup();
    must(await store.update(owner, "projects", p.id, { stageId: (await stageOfKind(v.id, "shipped")).id }));
    for (const s of (await stagesOf(other.id)).filter((x) => x.kind === "shipped")) {
      must(await store.setArchived(owner, "stages", s.id, true));
    }
    const moved = must(await store.update(owner, "projects", p.id, { ventureId: other.id })).record;
    expect(moved.ventureId).toBe(other.id);
    expect(moved.stageId).toBeNull();
  });

  it("clears the pointer of an archived project when the archived stage it sat at is deleted", async () => {
    const { v, p } = await setup();
    const stage = await stageOfKind(v.id, "paused");
    must(await store.update(owner, "projects", p.id, { stageId: stage.id }));
    must(await store.setArchived(owner, "projects", p.id, true));
    must(await store.setArchived(owner, "stages", stage.id, true));
    must(await store.remove(owner, "stages", stage.id, stage.name));
    expect(await store.get(owner, "stages", stage.id)).toBeNull();
    expect((await store.get(owner, "projects", p.id))?.stageId).toBeNull();
  });

  it("deletes an archived venture whose own and whose project's stage are set, counting five stages", async () => {
    const { v, p } = await setup();
    const stage = await stageOfKind(v.id, "active");
    must(await store.update(owner, "ventures", v.id, { stageId: stage.id }));
    must(await store.update(owner, "projects", p.id, { stageId: stage.id }));
    must(await store.setArchived(owner, "ventures", v.id, true));
    const done = must(await store.remove(owner, "ventures", v.id, "Farm"));
    expect(done.removes.stages).toBe(5);
    expect(await store.get(owner, "ventures", v.id)).toBeNull();
    expect(await store.get(owner, "projects", p.id)).toBeNull();
  });
});

describe("a stage and at risk are never counted", () => {
  it("leave the overview, today and every blocked flag as they were, and the stage name is not searchable", async () => {
    const v = await venture("Farm");
    const p = must(await store.create(owner, "projects", { ventureId: v.id, name: "Slice" })).record;
    const x = await task(v.id, "Order posts", { projectId: p.id, pickedOn: "2026-09-14" });
    must(await store.create(owner, "blockers", { taskId: x.id, reason: "Waiting" }));

    const blockedFlags = async () => {
      const tree = await store.tree(owner);
      return tree.ventures.map((tv) => [tv.blocked, tv.projects.map((tp) => tp.blocked)]);
    };
    const before = {
      overview: await store.overview(owner),
      today: await store.today(owner, "2026-09-14"),
      blocked: await blockedFlags(),
    };

    const stage = await stageOfKind(v.id, "stopped");
    must(await store.update(owner, "ventures", v.id, { stageId: stage.id, atRisk: true }));
    must(await store.update(owner, "projects", p.id, { stageId: stage.id, atRisk: true }));

    expect(await store.overview(owner)).toEqual(before.overview);
    expect(await store.today(owner, "2026-09-14")).toEqual(before.today);
    expect(await blockedFlags()).toEqual(before.blocked);
    expect(await store.search(owner, stage.name)).toEqual([]);
  });
});

describe("icons", () => {
  it("are stored as given on a venture and a project, from either set, unknown names included", async () => {
    const v = await venture("Studios", { icon: "lucide:rocket" });
    const p = must(await store.create(owner, "projects", { ventureId: v.id, name: "Repo", icon: "brand:github" })).record;
    const q = must(await store.create(owner, "projects", { ventureId: v.id, name: "Odd", icon: "lucide:not-an-icon-anywhere" })).record;
    expect([v.icon, p.icon, q.icon]).toEqual(["lucide:rocket", "brand:github", "lucide:not-an-icon-anywhere"]);
  });
});

describe("a milestone date", () => {
  it("is held and aimed at, and nothing computes lateness from it", async () => {
    const v = await venture("Farm");
    const p = must(await store.create(owner, "projects", { ventureId: v.id, name: "Fencing" })).record;
    const m = must(await store.create(owner, "milestones", { projectId: p.id, name: "Before the rain", aimingOn: "2020-01-01" })).record;
    await task(v.id, "Dig holes", { projectId: p.id, milestoneId: m.id });

    expect(Object.keys(m).sort()).toEqual(["aimingOn", "archivedAt", "createdAt", "id", "name", "position", "projectId", "stateId", "updatedAt"]);
    const next = (await store.overview(owner)).ventures[0]?.own.nextMilestone;
    expect(next).toEqual({ id: m.id, name: "Before the rain", aimingOn: "2020-01-01" });
    expect((await store.today(owner, "2026-09-14")).tasks).toEqual([]);
    expect(JSON.stringify(await store.tree(owner))).not.toMatch(/late|overdue/i);
  });
});

describe("today", () => {
  it("is what was picked today plus unfinished tasks with a date in the past, in one round trip", async () => {
    const v = await venture("Personal");
    const done = await stateOfKind(v.id, "finished");
    const picked = await task(v.id, "Picked today", { pickedOn: "2026-09-14" });
    await task(v.id, "Picked yesterday", { pickedOn: "2026-09-13" });
    const overdue = await task(v.id, "Overdue", { dueOn: "2026-09-10" });
    await task(v.id, "Overdue but done", { dueOn: "2026-09-10", stateId: done.id });
    await task(v.id, "Due later", { dueOn: "2026-09-20" });
    await task(v.id, "Due today", { dueOn: "2026-09-14" });

    t.resetCount();
    const today = await store.today(owner, "2026-09-14");
    expect(t.queries()).toBe(1);
    expect(today.tasks.map((x) => [x.id, x.picked, x.overdue])).toEqual([
      [picked.id, true, false],
      [overdue.id, false, true],
    ]);
  });
});

describe("the tree and search", () => {
  it("are one round trip each", async () => {
    const v = await venture("Studios");
    const p = must(await store.create(owner, "projects", { ventureId: v.id, name: "Tenet SDK" })).record;
    await task(v.id, "SDK alpha", { projectId: p.id });
    must(await store.create(owner, "notes", { ventureId: v.id, body: "Tommy prefers a call over a thread." }));

    t.resetCount();
    const tree = await store.tree(owner);
    expect(t.queries()).toBe(1);
    expect(tree.ventures[0]?.projects[0]?.tasks[0]?.title).toBe("SDK alpha");

    t.resetCount();
    // "s" is in the task, the venture, the project and the note, in either case.
    const hits = await store.search(owner, "s");
    expect(t.queries()).toBe(1);
    expect(new Set(hits.map((h) => h.kind))).toEqual(new Set(["task", "venture", "project", "note"]));
    expect(await store.search(owner, "100%_")).toEqual([]);
  });

  it("says where a note is, so its result can open that project", async () => {
    const v = await venture("Studios");
    const p = must(await store.create(owner, "projects", { ventureId: v.id, name: "Slice" })).record;
    const m = must(await store.create(owner, "milestones", { projectId: p.id, name: "Slice done" })).record;
    const x = await task(v.id, "Chase", { projectId: p.id });
    const onProject = must(await store.create(owner, "notes", { projectId: p.id, body: "kiwi on the project" })).record;
    // Task and milestone notes are cut: their old rows stay in the table and no result names them.
    await t.db.prepare(
      `INSERT INTO note (id, owner, task_id, body, created_at, updated_at) VALUES ('old-task-note', ?, ?, 'kiwi on the task', '2026-09-14T02:00:00.000Z', '2026-09-14T02:00:00.000Z')`,
    ).bind(owner, x.id).run();
    await t.db.prepare(
      `INSERT INTO note (id, owner, milestone_id, body, created_at, updated_at) VALUES ('old-milestone-note', ?, ?, 'kiwi on the milestone', '2026-09-14T02:00:00.000Z', '2026-09-14T02:00:00.000Z')`,
    ).bind(owner, m.id).run();
    const onVenture = must(await store.create(owner, "notes", { ventureId: v.id, body: `kiwi ${"long ".repeat(40)}` })).record;

    t.resetCount();
    const hits = await store.search(owner, "kiwi");
    expect(t.queries()).toBe(1);
    const of = (id: string) => hits.find((h) => h.id === id);
    expect(of("old-task-note")).toBeUndefined();
    expect(of("old-milestone-note")).toBeUndefined();
    expect(of(onProject.id)).toEqual({ kind: "note", id: onProject.id, ventureId: v.id, projectId: p.id, taskId: null, text: "kiwi on the project" });
    // A note on the venture itself has no place nearer than the venture. Its text is cut short.
    expect(of(onVenture.id)).toMatchObject({ projectId: null, taskId: null });
    expect(of(onVenture.id)?.text).toHaveLength(120);
    // A task says its own place too.
    expect((await store.search(owner, "Chase"))[0]).toEqual({ kind: "task", id: x.id, ventureId: v.id, projectId: p.id, taskId: x.id, text: "Chase" });
  });

  it("keeps a venture and a project in the results however many task titles share the word", async () => {
    const v = await venture("Design");
    const p = must(await store.create(owner, "projects", { ventureId: v.id, name: "Design system" })).record;
    // More task titles than the old single limit of fifty.
    for (let i = 0; i < 55; i++) await task(v.id, `Design pass ${String(i).padStart(2, "0")}`);

    const hits = await store.search(owner, "design");
    expect(hits.slice(0, 2).map((h) => [h.kind, h.id])).toEqual([["venture", v.id], ["project", p.id]]);
    expect(hits.filter((h) => h.kind === "task")).toHaveLength(40);
  });

  it("finds a task by its body or a step, and finds milestones, decisions, risks and links, saying where each sits", async () => {
    const v = await venture("Studios");
    const p = must(await store.create(owner, "projects", { ventureId: v.id, name: "Slice" })).record;
    const byBody = await task(v.id, "Call Tommy", { body: "About the kestrel trailer." });
    const byStep = await task(v.id, "Ship", { checklist: [{ text: "Cut the kestrel reel", done: false }] });
    // "done" and "text" are the steps' own keys; a search for them is not a match on every step.
    await task(v.id, "Plain", { checklist: [{ text: "Nothing here", done: true }] });
    const m = must(await store.create(owner, "milestones", { projectId: p.id, name: "Kestrel alpha" })).record;
    const d = must(await store.create(owner, "decisions", { projectId: p.id, title: "Engine", body: "Kestrel, not Unity." })).record;
    const r = must(await store.create(owner, "risks", { ventureId: v.id, title: "Kestrel licence lapses" })).record;
    const l = must(await store.create(owner, "links", { taskId: byBody.id, url: "https://example.com/kestrel" })).record;

    t.resetCount();
    const hits = await store.search(owner, "kestrel");
    expect(t.queries()).toBe(1);
    expect(hits.map((h) => [h.kind, h.id, h.ventureId, h.projectId, h.taskId])).toEqual([
      ["milestone", m.id, v.id, p.id, null],
      ["task", byBody.id, v.id, null, byBody.id],
      ["task", byStep.id, v.id, null, byStep.id],
      ["decision", d.id, v.id, p.id, null],
      ["risk", r.id, v.id, null, null],
      ["link", l.id, v.id, null, byBody.id],
    ]);
    expect(hits.find((h) => h.kind === "task")?.text).toBe("Call Tommy");
    expect(await store.search(owner, "done")).toEqual([]);
  });
});

describe("archiving", () => {
  it("removes every kind of record from every view, and can be undone", async () => {
    const v = await venture("Studios");
    const other = await venture("Network");
    const p = must(await store.create(owner, "projects", { ventureId: v.id, name: "Slice" })).record;
    const m = must(await store.create(owner, "milestones", { projectId: p.id, name: "Slice done" })).record;
    const x = await task(v.id, "Chase", { projectId: p.id, milestoneId: m.id });
    const spare = must(await store.create(owner, "states", { ventureId: v.id, name: "spare", kind: "underway" })).record;
    const spareStage = must(await store.create(owner, "stages", { ventureId: v.id, name: "spare", kind: "paused" })).record;
    const records: Record<Kind, { id: string }> = {
      ventures: other,
      states: spare,
      stages: spareStage,
      projects: p,
      milestones: m,
      tasks: x,
      blockers: must(await store.create(owner, "blockers", { taskId: x.id, reason: "Art" })).record,
      notes: must(await store.create(owner, "notes", { ventureId: v.id, body: "One street." })).record,
      decisions: must(await store.create(owner, "decisions", { ventureId: v.id, title: "Ship small" })).record,
      risks: must(await store.create(owner, "risks", { projectId: p.id, title: "Rain" })).record,
      links: must(await store.create(owner, "links", { taskId: x.id, url: "https://www.icloud.com/notes/abc" })).record,
      tags: must(await store.create(owner, "tags", { name: "legal" })).record,
    };
    const listed = async (kind: Kind) => must(await store.list(owner, kind, {})).map((r) => r.id);

    for (const kind of KINDS) {
      const { id } = records[kind];
      expect(await listed(kind), `${kind} before`).toContain(id);
      must(await store.setArchived(owner, kind, id, true));
      expect(await listed(kind), `${kind} archived`).not.toContain(id);
      expect((await store.archived(owner)).map((a) => a.id), `${kind} in the archive`).toContain(id);
      must(await store.setArchived(owner, kind, id, false));
      expect(await listed(kind), `${kind} restored`).toContain(id);
    }
  });

  it("of a milestone keeps its tasks in view in the project, and unarchiving it still works", async () => {
    const v = await venture("Studios");
    const p = must(await store.create(owner, "projects", { ventureId: v.id, name: "Slice" })).record;
    const m = must(await store.create(owner, "milestones", { projectId: p.id, name: "Reached" })).record;
    const open = await task(v.id, "Still open", { projectId: p.id, milestoneId: m.id, pickedOn: "2026-09-14" });
    const done = await task(v.id, "Done", { projectId: p.id, milestoneId: m.id, stateId: (await stateOfKind(v.id, "finished")).id });

    const archived = must(await store.setArchived(owner, "milestones", m.id, true));
    expect(archived.record.archivedAt).not.toBeNull();
    expect(archived.ventureId).toBe(v.id);

    const after = await store.get(owner, "tasks", open.id);
    expect(after).toMatchObject({ projectId: p.id, milestoneId: null, archivedAt: null });
    expect(must(await store.list(owner, "tasks", { venture: v.id })).map((r) => r.id).sort()).toEqual([open.id, done.id].sort());
    expect((await store.today(owner, "2026-09-14")).tasks.map((r) => r.id)).toEqual([open.id]);
    expect((await store.search(owner, "Still open")).map((h) => h.id)).toEqual([open.id]);
    expect((await store.overview(owner)).ventures[0]?.own.tasksLeft).toBe(1);
    expect((await store.tree(owner)).ventures[0]?.projects[0]?.tasks.map((r) => r.id)).toContain(open.id);

    must(await store.setArchived(owner, "milestones", m.id, false));
    expect(must(await store.list(owner, "milestones", { project: p.id })).map((r) => r.id)).toEqual([m.id]);
    expect((await store.get(owner, "tasks", open.id))?.milestoneId).toBeNull();
  });

  it("of a project hides its milestones and tasks and changes none of them", async () => {
    const v = await venture("Studios");
    const p = must(await store.create(owner, "projects", { ventureId: v.id, name: "Slice" })).record;
    const m = must(await store.create(owner, "milestones", { projectId: p.id, name: "Done" })).record;
    const x = await task(v.id, "Chase", { projectId: p.id, milestoneId: m.id });
    must(await store.setArchived(owner, "projects", p.id, true));
    expect(must(await store.list(owner, "tasks", { venture: v.id }))).toEqual([]);
    expect(must(await store.list(owner, "milestones", { venture: v.id }))).toEqual([]);
    expect((await store.get(owner, "tasks", x.id))?.archivedAt).toBeNull();

    must(await store.setArchived(owner, "projects", p.id, false));
    expect(must(await store.list(owner, "tasks", { venture: v.id })).map((r) => r.id)).toEqual([x.id]);
    expect((await store.get(owner, "tasks", x.id))?.milestoneId).toBe(m.id);
  });
});

describe("a create under a client's id", () => {
  it("is made once however many times it is sent, and refuses an id that names something else", async () => {
    const v = await venture("Studios");
    const id = crypto.randomUUID();
    const first = must(await store.create(owner, "tasks", { id, ventureId: v.id, title: "Queued offline" }));
    expect(first.record.id).toBe(id);
    expect(first.replayed).toBeUndefined();

    const again = must(await store.create(owner, "tasks", { id, ventureId: v.id, title: "Queued offline" }));
    expect(again).toEqual({ record: first.record, ventureId: v.id, replayed: true });
    expect(must(await store.list(owner, "tasks", { venture: v.id })).map((r) => r.id)).toEqual([id]);

    expect(await store.create(owner, "notes", { id, ventureId: v.id, body: "Same id, other kind" }))
      .toMatchObject({ ok: false, status: 409 });
    expect(await store.create("someone-else", "tasks", { id, ventureId: v.id, title: "Theirs" }))
      .toMatchObject({ ok: false, status: 409 });

    const holdings = must(await store.create(owner, "ventures", { id: "venture-from-the-client", name: "Holdings" })).record;
    expect(holdings.id).toBe("venture-from-the-client");
    expect((await statesOf(holdings.id)).length).toBe(3);
    must(await store.create(owner, "ventures", { id: "venture-from-the-client", name: "Holdings" }));
    expect((await statesOf(holdings.id)).length).toBe(3);
  });
});

describe("deleting, decision 33", () => {
  const archive = async (kind: Kind, id: string) => must(await store.setArchived(owner, kind, id, true));

  it("refuses something nobody archived, and destroys nothing", async () => {
    const v = await venture("Career");
    const x = await task(v.id, "Chase the invoice");
    const preview = await store.deletePreview(owner, "tasks", x.id);
    expect(preview?.refusal).toBe("Archive it first. Only something already archived can be deleted.");
    expect(preview?.confirm).toBe("Chase the invoice");
    expect(await store.remove(owner, "tasks", x.id, "Chase the invoice")).toMatchObject({ ok: false, status: 409 });
    expect(await store.get(owner, "tasks", x.id)).not.toBeNull();
  });

  it("refuses a venture that owns another, and names it", async () => {
    const top = await venture("Black Dingo Studios");
    await venture("Sawtooth Records", { parentId: top.id });
    await archive("ventures", top.id);
    const preview = await store.deletePreview(owner, "ventures", top.id);
    expect(preview?.refusal).toBe("It owns Sawtooth Records. Delete or move those first.");
    expect(await store.remove(owner, "ventures", top.id, "Black Dingo Studios")).toMatchObject({ ok: false, status: 409 });
    expect(await store.get(owner, "ventures", top.id)).not.toBeNull();
  });

  it("counts an archived child as a child, so an owner cannot be deleted out from under one", async () => {
    const parent = await venture("Holdings");
    const child = await venture("Subsidiary", { parentId: parent.id });
    await archive("ventures", child.id);
    await archive("ventures", parent.id);
    expect((await store.deletePreview(owner, "ventures", parent.id))?.refusal)
      .toBe("It owns Subsidiary. Delete or move those first.");
  });

  it("refuses a name that does not match, exactly, and destroys nothing", async () => {
    const v = await venture("The Farm");
    const x = await task(v.id, "Order the posts");
    await archive("tasks", x.id);
    expect(await store.remove(owner, "tasks", x.id, "order the posts")).toMatchObject({ ok: false, status: 400 });
    expect(await store.remove(owner, "tasks", x.id, "Order the post")).toMatchObject({ ok: false, status: 400 });
    expect(await store.get(owner, "tasks", x.id)).not.toBeNull();
    // Surrounding space is forgiven: a name pasted out of the archive often carries some.
    expect(await store.remove(owner, "tasks", x.id, "  Order the posts ")).toMatchObject({ ok: true });
    expect(await store.get(owner, "tasks", x.id)).toBeNull();
  });

  it("counts the whole cascade of a venture, then destroys exactly that", async () => {
    const studios = await venture("Studios");
    const other = await venture("Elsewhere");
    const project = must(await store.create(owner, "projects", { ventureId: studios.id, name: "Website" })).record;
    const milestone = must(await store.create(owner, "milestones", { projectId: project.id, name: "Launch" })).record;
    const inProject = await task(studios.id, "Write the copy", { projectId: project.id, milestoneId: milestone.id });
    const loose = await task(studios.id, "Renew the domain");
    const blocker = must(await store.create(owner, "blockers", { taskId: inProject.id, reason: "Waiting on art" })).record;
    const link = must(await store.create(owner, "links", { taskId: loose.id, url: "https://example.com" })).record;
    // A task note is cut from the app, but its row stays and goes with its task.
    await t.db.prepare(
        `INSERT INTO note (id, owner, task_id, body, created_at, updated_at) VALUES ('legacy-task-note', ?, ?, 'Say less', '2026-09-14T02:00:00.000Z', '2026-09-14T02:00:00.000Z')`,
      ).bind(owner, inProject.id).run();
    const note = { id: "legacy-task-note" };
    const ventureNote = must(await store.create(owner, "notes", { ventureId: studios.id, body: "About the studio" })).record;
    const keptTask = await task(other.id, "Nothing to do with it");

    await archive("ventures", studios.id);
    const preview = await store.deletePreview(owner, "ventures", studios.id);
    expect(preview?.removes).toEqual({
      tags: 0, taskTags: 0, projectTags: 0,
      ventures: 1, states: 3, stages: 5, projects: 1, milestones: 1,
      tasks: 2, blockers: 1, notes: 2, decisions: 0, risks: 0, links: 1,
    });

    const done = must(await store.remove(owner, "ventures", studios.id, "Studios"));
    expect(done.removes).toEqual(preview?.removes);
    expect(done.ventureId).toBe(studios.id);

    for (const [kind, id] of [
      ["ventures", studios.id], ["projects", project.id], ["milestones", milestone.id],
      ["tasks", inProject.id], ["tasks", loose.id], ["blockers", blocker.id],
      ["links", link.id], ["notes", note.id], ["notes", ventureNote.id],
    ] as const) {
      expect(await store.get(owner, kind, id), `${kind} ${id}`).toBeNull();
    }
    expect((await statesOf(studios.id)).length).toBe(0);
    // Nothing outside it moved.
    expect(await store.get(owner, "ventures", other.id)).not.toBeNull();
    expect(await store.get(owner, "tasks", keptTask.id)).not.toBeNull();
  });

  it("keeps a blocker in another venture that waited on a destroyed task, and lets it go", async () => {
    const mine = await venture("Mine");
    const theirs = await venture("Theirs");
    const waitedOn = await task(mine.id, "Hire the auger");
    const waiting = await task(theirs.id, "Clear the line");
    const blocker = must(await store.create(owner, "blockers", {
      taskId: waiting.id, reason: "waiting on Hire the auger", waitsOnTaskId: waitedOn.id,
    })).record;

    await archive("ventures", mine.id);
    expect((await store.deletePreview(owner, "ventures", mine.id))?.removes.blockers).toBe(0);
    must(await store.remove(owner, "ventures", mine.id, "Mine"));

    const kept = await store.get(owner, "blockers", blocker.id);
    expect(kept).not.toBeNull();
    expect(kept?.reason).toBe("waiting on Hire the auger");
    expect(kept?.waitsOnTaskId).toBeNull();
    expect(await store.get(owner, "tasks", waiting.id)).not.toBeNull();
  });

  it("lets a destroyed milestone go of its tasks rather than taking them, as archiving one does", async () => {
    const v = await venture("Records");
    const project = must(await store.create(owner, "projects", { ventureId: v.id, name: "First press" })).record;
    const milestone = must(await store.create(owner, "milestones", { projectId: project.id, name: "Master" })).record;
    const x = await task(v.id, "Master the tracks", { projectId: project.id, milestoneId: milestone.id });

    await archive("milestones", milestone.id);
    expect((await store.deletePreview(owner, "milestones", milestone.id))?.removes)
      .toMatchObject({ milestones: 1, tasks: 0, notes: 0 });
    must(await store.remove(owner, "milestones", milestone.id, "Master"));

    expect(await store.get(owner, "milestones", milestone.id)).toBeNull();
    const kept = await store.get(owner, "tasks", x.id);
    expect(kept?.milestoneId).toBeNull();
    expect(kept?.projectId).toBe(project.id);
  });

  it("lets a destroyed state go of the archived task still sitting in it", async () => {
    const v = await venture("Day job");
    const doing = await stateOfKind(v.id, "underway");
    const x = await task(v.id, "Write the runbook", { stateId: doing.id });
    // An open task stops a state being archived; an archived one does not, which is how a
    // state comes to be deletable while a row still points at it.
    await archive("tasks", x.id);
    await archive("states", doing.id);

    must(await store.remove(owner, "states", doing.id, doing.name));
    expect(await store.get(owner, "states", doing.id)).toBeNull();
    const kept = await store.get(owner, "tasks", x.id);
    expect(kept).not.toBeNull();
    expect(kept?.stateId).toBeNull();
  });

  it("destroys a project's work and leaves the venture standing", async () => {
    const v = await venture("Print shop");
    const project = must(await store.create(owner, "projects", { ventureId: v.id, name: "Reopening" })).record;
    const x = await task(v.id, "Service the press", { projectId: project.id });
    const loose = await task(v.id, "Renew the lease");
    await archive("projects", project.id);

    expect((await store.deletePreview(owner, "projects", project.id))?.removes)
      .toMatchObject({ projects: 1, tasks: 1, ventures: 0, states: 0 });
    must(await store.remove(owner, "projects", project.id, "Reopening"));

    expect(await store.get(owner, "projects", project.id)).toBeNull();
    expect(await store.get(owner, "tasks", x.id)).toBeNull();
    expect(await store.get(owner, "tasks", loose.id)).not.toBeNull();
    expect(await store.get(owner, "ventures", v.id)).not.toBeNull();
  });

  it("asks for the word delete where there is no name to type", async () => {
    const v = await venture("Sawtooth");
    const x = await task(v.id, "Mix it");
    const blocker = must(await store.create(owner, "blockers", { taskId: x.id, reason: "Waiting on a quote" })).record;
    await archive("blockers", blocker.id);
    const preview = await store.deletePreview(owner, "blockers", blocker.id);
    expect(preview?.label).toBe("Waiting on a quote");
    expect(preview?.confirm).toBe("delete");
    expect(await store.remove(owner, "blockers", blocker.id, "Waiting on a quote"))
      .toMatchObject({ ok: false, status: 400 });
    must(await store.remove(owner, "blockers", blocker.id, "delete"));
    expect(await store.get(owner, "blockers", blocker.id)).toBeNull();
    expect(await store.get(owner, "tasks", x.id)).not.toBeNull();
  });

  it("belongs to its owner and to nobody else", async () => {
    const v = await venture("Private");
    await archive("ventures", v.id);
    expect(await store.deletePreview("someone-else", "ventures", v.id)).toBeNull();
    expect(await store.remove("someone-else", "ventures", v.id, "Private")).toMatchObject({ ok: false, status: 404 });
    expect(await store.get(owner, "ventures", v.id)).not.toBeNull();
  });
});

/**
 * The archive restores several things as one call each, in whatever order they were chosen.
 * That is only safe if the order cannot matter: every restore clears one stamp, and whether
 * a thing shows is read from its parents at read time, never written into the child.
 */
describe("restoring several things", () => {
  const visibleTaskIds = async () =>
    (await store.tree(owner)).ventures.flatMap((v) => [...v.tasks, ...v.projects.flatMap((p) => p.tasks)]).map((r) => r.id);

  // One case per order, so each names its own failure and neither pays for two setups.
  const restoredInOrder = async (order: readonly ("projects" | "ventures")[]) => {
    const v = await venture("Studios");
    const p = must(await store.create(owner, "projects", { ventureId: v.id, name: "Slice" })).record;
    const x = await task(v.id, "Chase", { projectId: p.id });
    must(await store.setArchived(owner, "projects", p.id, true));
    must(await store.setArchived(owner, "ventures", v.id, true));
    expect((await store.archived(owner)).map((a) => a.id).sort()).toEqual([v.id, p.id].sort());

    const ids = { projects: p.id, ventures: v.id };
    for (const kind of order) must(await store.setArchived(owner, kind, ids[kind], false));

    expect(await store.archived(owner)).toEqual([]);
    expect((await store.tree(owner)).ventures[0]?.projects.map((r) => r.id)).toEqual([p.id]);
    expect(await visibleTaskIds()).toEqual([x.id]);
  };

  it("brings a project back with its venture when the project is restored first", async () => {
    await restoredInOrder(["projects", "ventures"]);
  });

  it("brings a project back with its venture when the venture is restored first", async () => {
    await restoredInOrder(["ventures", "projects"]);
  });

  it("restores a project whose venture is still archived, and shows it once the venture is back", async () => {
    const v = await venture("Studios");
    const p = must(await store.create(owner, "projects", { ventureId: v.id, name: "Slice" })).record;
    must(await store.setArchived(owner, "projects", p.id, true));
    must(await store.setArchived(owner, "ventures", v.id, true));

    must(await store.setArchived(owner, "projects", p.id, false));
    // Out of the archive and not yet in view: it sits in a venture that is still put away.
    expect((await store.archived(owner)).map((a) => a.id)).toEqual([v.id]);
    expect(must(await store.list(owner, "projects", {}))).toEqual([]);
    expect((await store.get(owner, "projects", p.id))?.archivedAt).toBeNull();

    must(await store.setArchived(owner, "ventures", v.id, false));
    expect(must(await store.list(owner, "projects", {})).map((r) => r.id)).toEqual([p.id]);
  });

  it("brings back a task, its blocker and the tag it carries in the order a person would click them", async () => {
    const v = await venture("Studios");
    const legal = must(await store.create(owner, "tags", { name: "legal" })).record;
    const x = await task(v.id, "File the return", { tagIds: [legal.id] });
    const b = must(await store.create(owner, "blockers", { taskId: x.id, reason: "Waiting on the accountant" })).record;
    must(await store.setArchived(owner, "blockers", b.id, true));
    must(await store.setArchived(owner, "tags", legal.id, true));
    must(await store.setArchived(owner, "tasks", x.id, true));

    // The task first, then what hangs off it: the order that would hide something, if any did.
    for (const [kind, id] of [["tasks", x.id], ["blockers", b.id], ["tags", legal.id]] as const) {
      must(await store.setArchived(owner, kind, id, false));
    }

    expect(await store.archived(owner)).toEqual([]);
    const back = (await store.tree(owner)).ventures[0]?.tasks.find((r) => r.id === x.id);
    expect(back?.tagIds).toEqual([legal.id]);
    expect(back?.blocker?.id).toBe(b.id);
  });
});

describe("tags", () => {
  const tag = async (name: string) => must(await store.create(owner, "tags", { name })).record;
  const at = "2026-09-14T02:00:00.000Z";

  const assign = async (table: "task_tag" | "project_tag", column: string, id: string, tagId: string) => {
    await t.db.prepare(
      `INSERT INTO ${table} (id, owner, ${column}, tag_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
    ).bind(crypto.randomUUID(), owner, id, tagId, at, at).run();
  };

  const assignments = async (table: "task_tag" | "project_tag") =>
    (await t.db.prepare(`SELECT count(*) AS n FROM ${table} WHERE owner = ?`).bind(owner).first<{ n: number }>())?.n;

  it("is a name and nothing else, read back by id and listed in the order it will be shown in", async () => {
    const legal = await tag("legal");
    const admin = await tag("admin");
    expect(await store.get(owner, "tags", legal.id)).toMatchObject({ name: "legal", archivedAt: null });
    expect(must(await store.list(owner, "tags", {})).map((r) => r.name)).toEqual(["admin", "legal"]);
    expect(admin.id).not.toBe(legal.id);
  });

  it("refuses a second live tag of the same name, and writes nothing", async () => {
    const first = await tag("deep work");
    expect(await store.create(owner, "tags", { name: "deep work" })).toMatchObject({ ok: false, status: 409 });
    expect(must(await store.list(owner, "tags", {})).map((r) => r.id)).toEqual([first.id]);
  });

  it("refuses a name that is nothing but spaces, and says which field", async () => {
    expect(await store.create(owner, "tags", { name: "   " }))
      .toMatchObject({ ok: false, status: 400, error: "a tag needs a name" });
    expect(must(await store.list(owner, "tags", {}))).toEqual([]);
  });

  it("lets go of its name when it is archived, so the word can be used again", async () => {
    const first = await tag("admin");
    must(await store.setArchived(owner, "tags", first.id, true));
    const second = await tag("admin");
    expect(second.id).not.toBe(first.id);
    expect(must(await store.list(owner, "tags", {})).map((r) => r.id)).toEqual([second.id]);
  });

  it("says which tag and which word when it cannot come back because its name was taken", async () => {
    const first = await tag("legal");
    must(await store.setArchived(owner, "tags", first.id, true));
    const second = await tag("legal");

    // A bulk restore of twenty rows answers this for one of them: the refusal has to say
    // which, or there is no way to tell what to rename.
    expect(await store.setArchived(owner, "tags", first.id, false)).toEqual({
      ok: false, status: 409, error: `the tag "legal" cannot come back while another tag is called "legal": rename one of them first`,
    });
    expect((await store.get(owner, "tags", first.id))?.archivedAt).not.toBeNull();
    expect(must(await store.list(owner, "tags", {})).map((r) => r.id)).toEqual([second.id]);

    must(await store.update(owner, "tags", second.id, { name: "legal (new)" }));
    must(await store.setArchived(owner, "tags", first.id, false));
    expect(must(await store.list(owner, "tags", {})).map((r) => r.name)).toEqual(["legal", "legal (new)"]);
  });

  it("comes back when another owner holds the same word, or when its own archived twin does", async () => {
    const mine = await tag("legal");
    must(await store.setArchived(owner, "tags", mine.id, true));
    const twin = await tag("legal");
    must(await store.setArchived(owner, "tags", twin.id, true));
    must(await store.create(`owner-${crypto.randomUUID()}`, "tags", { name: "legal" }));

    must(await store.setArchived(owner, "tags", mine.id, false));
    expect(must(await store.list(owner, "tags", {})).map((r) => r.id)).toEqual([mine.id]);
  });

  it("is one owner's own, so two owners may each have a tag of the same name", async () => {
    const mine = await tag("legal");
    const stranger = `owner-${crypto.randomUUID()}`;
    const theirs = must(await store.create(stranger, "tags", { name: "legal" })).record;
    expect(theirs.id).not.toBe(mine.id);
    expect(must(await store.list(owner, "tags", {})).map((r) => r.id)).toEqual([mine.id]);
    expect(must(await store.list(stranger, "tags", {})).map((r) => r.id)).toEqual([theirs.id]);
  });

  it("is renamed by a patch, and refuses to be renamed to nothing", async () => {
    const legal = await tag("legal");
    expect(must(await store.update(owner, "tags", legal.id, { name: "compliance" })).record.name).toBe("compliance");
    expect(await store.update(owner, "tags", legal.id, { name: " " }))
      .toMatchObject({ ok: false, status: 400, error: "a tag needs a name" });
    expect((await store.get(owner, "tags", legal.id))?.name).toBe("compliance");
  });

  it("takes its assignments with it when it is deleted, and leaves the task standing", async () => {
    const v = await venture("Studios");
    const x = await task(v.id, "File the return");
    const legal = await tag("legal");
    // Writing an assignment is the next task's work. This is the row it will write, put
    // here by hand so that the cascade written in this one has something to take.
    await assign("task_tag", "task_id", x.id, legal.id);

    must(await store.setArchived(owner, "tags", legal.id, true));
    expect((await store.deletePreview(owner, "tags", legal.id))?.removes)
      .toMatchObject({ tags: 1, taskTags: 1, projectTags: 0, tasks: 0 });
    must(await store.remove(owner, "tags", legal.id, "legal"));

    expect(await store.get(owner, "tags", legal.id)).toBeNull();
    expect(await store.get(owner, "tasks", x.id)).not.toBeNull();
    expect(await assignments("task_tag")).toBe(0);
  });

  it("stays when the task it was on is deleted, and the assignment goes", async () => {
    const v = await venture("Studios");
    const x = await task(v.id, "File the return");
    const legal = await tag("legal");
    await assign("task_tag", "task_id", x.id, legal.id);

    must(await store.setArchived(owner, "tasks", x.id, true));
    expect((await store.deletePreview(owner, "tasks", x.id))?.removes).toMatchObject({ tasks: 1, taskTags: 1, tags: 0 });
    must(await store.remove(owner, "tasks", x.id, "File the return"));

    expect(await store.get(owner, "tasks", x.id)).toBeNull();
    expect(await store.get(owner, "tags", legal.id)).not.toBeNull();
    expect(await assignments("task_tag")).toBe(0);
  });

  it("stays when the project it was on is deleted, and so do the assignments on its tasks", async () => {
    const v = await venture("Studios");
    const p = must(await store.create(owner, "projects", { ventureId: v.id, name: "Slice" })).record;
    const x = await task(v.id, "Street layout", { projectId: p.id });
    const deep = await tag("deep work");
    await assign("project_tag", "project_id", p.id, deep.id);
    await assign("task_tag", "task_id", x.id, deep.id);

    must(await store.setArchived(owner, "projects", p.id, true));
    expect((await store.deletePreview(owner, "projects", p.id))?.removes)
      .toMatchObject({ projects: 1, tasks: 1, taskTags: 1, projectTags: 1, tags: 0 });
    must(await store.remove(owner, "projects", p.id, "Slice"));

    expect(await store.get(owner, "tags", deep.id)).not.toBeNull();
    expect(await assignments("task_tag")).toBe(0);
    expect(await assignments("project_tag")).toBe(0);
  });

  it("stays when the venture beneath it is deleted, and every assignment under it goes", async () => {
    const v = await venture("Studios");
    const p = must(await store.create(owner, "projects", { ventureId: v.id, name: "Slice" })).record;
    const x = await task(v.id, "Street layout", { projectId: p.id });
    const admin = await tag("admin");
    await assign("project_tag", "project_id", p.id, admin.id);
    await assign("task_tag", "task_id", x.id, admin.id);

    must(await store.setArchived(owner, "ventures", v.id, true));
    expect((await store.deletePreview(owner, "ventures", v.id))?.removes)
      .toMatchObject({ ventures: 1, taskTags: 1, projectTags: 1, tags: 0 });
    must(await store.remove(owner, "ventures", v.id, "Studios"));

    expect(await store.get(owner, "tags", admin.id)).not.toBeNull();
    expect(await assignments("task_tag")).toBe(0);
    expect(await assignments("project_tag")).toBe(0);
  });

  const treeTask = async (id: string) => {
    const tree = await store.tree(owner);
    const all = tree.ventures.flatMap((v) => [...v.tasks, ...v.projects.flatMap((p) => p.tasks)]);
    const found = all.find((x) => x.id === id);
    if (found === undefined) throw new Error(`task ${id} is not in the tree`);
    return found;
  };

  it("is carried on a task through the tree, in the order the names read in", async () => {
    const v = await venture("Studios");
    const legal = await tag("legal");
    const admin = await tag("admin");
    const x = await task(v.id, "File the return", { tagIds: [legal.id, admin.id] });
    // admin before legal: the order is the tag's name, never the order they were given in.
    expect((await treeTask(x.id)).tagIds).toEqual([admin.id, legal.id]);
    expect(await assignments("task_tag")).toBe(2);
  });

  it("is written whole by a patch: one id drops the other, an empty list clears, an absent key changes nothing", async () => {
    const v = await venture("Studios");
    const legal = await tag("legal");
    const admin = await tag("admin");
    const x = await task(v.id, "File the return", { tagIds: [legal.id, admin.id] });

    must(await store.update(owner, "tasks", x.id, { tagIds: [legal.id] }));
    expect((await treeTask(x.id)).tagIds).toEqual([legal.id]);

    must(await store.update(owner, "tasks", x.id, { title: "File it" }));
    expect((await treeTask(x.id)).tagIds).toEqual([legal.id]);

    must(await store.update(owner, "tasks", x.id, { tagIds: [] }));
    expect((await treeTask(x.id)).tagIds).toEqual([]);
    expect(await assignments("task_tag")).toBe(0);
  });

  it("does not destroy an assignment whose tag is archived, because nobody was shown it", async () => {
    const v = await venture("Studios");
    const legal = await tag("legal");
    const admin = await tag("admin");
    const deep = await tag("deep work");
    const x = await task(v.id, "File the return", { tagIds: [legal.id, admin.id] });

    must(await store.setArchived(owner, "tags", legal.id, true));
    // What a picker would be given: legal has dropped out of the read, so a write built
    // from it can say nothing about legal either way.
    expect((await treeTask(x.id)).tagIds).toEqual([admin.id]);

    must(await store.update(owner, "tasks", x.id, { tagIds: [admin.id, deep.id] }));
    expect((await treeTask(x.id)).tagIds).toEqual([admin.id, deep.id]);

    must(await store.setArchived(owner, "tags", legal.id, false));
    expect((await treeTask(x.id)).tagIds).toEqual([admin.id, deep.id, legal.id]);
    expect(await assignments("task_tag")).toBe(3);
  });

  it("still clears every live tag when the list is empty, sparing only the archived one", async () => {
    const v = await venture("Studios");
    const legal = await tag("legal");
    const admin = await tag("admin");
    const x = await task(v.id, "File the return", { tagIds: [legal.id, admin.id] });
    must(await store.setArchived(owner, "tags", legal.id, true));

    must(await store.update(owner, "tasks", x.id, { tagIds: [] }));
    expect((await treeTask(x.id)).tagIds).toEqual([]);
    // admin's row is gone; legal's, which the write was never given, is still there.
    expect(await assignments("task_tag")).toBe(1);

    must(await store.setArchived(owner, "tags", legal.id, false));
    expect((await treeTask(x.id)).tagIds).toEqual([legal.id]);
  });

  it("refuses a tag that is another owner's, and writes nothing", async () => {
    const v = await venture("Studios");
    const mine = await tag("legal");
    const stranger = `owner-${crypto.randomUUID()}`;
    const theirs = must(await store.create(stranger, "tags", { name: "theirs" })).record;

    expect(await store.create(owner, "tasks", { ventureId: v.id, title: "File the return", tagIds: [theirs.id] }))
      .toMatchObject({ ok: false, status: 404, error: `tag ${theirs.id} was not found` });
    expect(await assignments("task_tag")).toBe(0);

    const x = await task(v.id, "File the return", { tagIds: [mine.id] });
    expect(await store.update(owner, "tasks", x.id, { tagIds: [mine.id, theirs.id] }))
      .toMatchObject({ ok: false, status: 404, error: `tag ${theirs.id} was not found` });
    expect((await treeTask(x.id)).tagIds).toEqual([mine.id]);
  });

  it("cannot be put on anything once it is archived", async () => {
    const v = await venture("Studios");
    const legal = await tag("legal");
    must(await store.setArchived(owner, "tags", legal.id, true));
    expect(await store.create(owner, "tasks", { ventureId: v.id, title: "File the return", tagIds: [legal.id] }))
      .toMatchObject({ ok: false, status: 404, error: `tag ${legal.id} was not found` });
    expect(await assignments("task_tag")).toBe(0);
  });

  it("is carried on a project through the tree the same way", async () => {
    const v = await venture("Studios");
    const deep = await tag("deep work");
    const p = must(await store.create(owner, "projects", { ventureId: v.id, name: "Slice", tagIds: [deep.id] })).record;
    expect((await store.tree(owner)).ventures[0]?.projects[0]?.tagIds).toEqual([deep.id]);

    must(await store.update(owner, "projects", p.id, { tagIds: [] }));
    expect((await store.tree(owner)).ventures[0]?.projects[0]?.tagIds).toEqual([]);
    expect(await assignments("project_tag")).toBe(0);
  });

  it("lands once when the same id is given twice", async () => {
    const v = await venture("Studios");
    const legal = await tag("legal");
    const x = await task(v.id, "File the return", { tagIds: [legal.id, legal.id] });
    expect((await treeTask(x.id)).tagIds).toEqual([legal.id]);
    expect(await assignments("task_tag")).toBe(1);
  });

  it("leaves the tree and today one round trip each", async () => {
    const v = await venture("Studios");
    const legal = await tag("legal");
    const admin = await tag("admin");
    const p = must(await store.create(owner, "projects", { ventureId: v.id, name: "Slice", tagIds: [admin.id] })).record;
    const x = await task(v.id, "File the return", {
      projectId: p.id, pickedOn: "2026-09-14", tagIds: [legal.id, admin.id],
    });

    t.resetCount();
    const tree = await store.tree(owner);
    expect(t.queries()).toBe(1);
    expect(tree.ventures[0]?.projects[0]?.tasks[0]?.tagIds).toEqual([admin.id, legal.id]);

    t.resetCount();
    const today = await store.today(owner, "2026-09-14");
    expect(t.queries()).toBe(1);
    expect(today.tasks.find((r) => r.id === x.id)?.tagIds).toEqual([admin.id, legal.id]);
  });
});

describe("exporting everything one account made", () => {
  it("holds only the asked owner's rows, and strips owner from every row", async () => {
    const v = await venture("Studios");
    const legal = must(await store.create(owner, "tags", { name: "legal" })).record;
    const x = await task(v.id, "File the return", { tagIds: [legal.id] });

    const stranger = `owner-${crypto.randomUUID()}`;
    must(await store.create(stranger, "ventures", { name: "Theirs" }));

    const doc = await store.exportAll(owner, new Date("2026-09-15T00:00:00Z"));

    expect(doc.format).toBe("vemi-export");
    expect(doc.version).toBe(2);
    expect(doc.exportedAt).toBe("2026-09-15T00:00:00.000Z");
    expect(doc.tables.venture?.map((r) => r.id)).toEqual([v.id]);
    expect(doc.tables.task?.map((r) => r.id)).toEqual([x.id]);
    expect(doc.tables.tag?.map((r) => r.id)).toEqual([legal.id]);
    expect(doc.tables.task_tag).toHaveLength(1);

    for (const rows of Object.values(doc.tables)) {
      for (const row of rows) expect(row).not.toHaveProperty("owner");
    }
  });

  it("leaves out the old notes on a task or a milestone and keeps the rest", async () => {
    const v = await venture("Studios");
    const x = await task(v.id, "Chase");
    must(await store.create(owner, "notes", { ventureId: v.id, body: "About the studio" }));
    await t.db.prepare(
      `INSERT INTO note (id, owner, task_id, body, created_at, updated_at) VALUES ('export-old-task-note', ?, ?, 'Gone', '2026-09-14T02:00:00.000Z', '2026-09-14T02:00:00.000Z')`,
    ).bind(owner, x.id).run();

    const doc = await store.exportAll(owner, new Date());
    expect(doc.tables.note?.map((r) => r.body)).toEqual(["About the studio"]);
  });

  it("includes archived rows", async () => {
    const v = await venture("Studios");
    must(await store.setArchived(owner, "ventures", v.id, true));

    const doc = await store.exportAll(owner, new Date());
    const row = doc.tables.venture?.find((r) => r.id === v.id);
    expect(row).toBeDefined();
    expect(row?.archived_at).not.toBeNull();
  });

  it("exports or excludes every table that has an owner column, no third option", async () => {
    // Independent of exportAll's own OWNER_COLUMN regex (store.ts) — this asks D1 itself,
    // per table, whether it actually has a column named `owner`. D1 refuses to correlate
    // pragma_table_info to sqlite_master (SQLITE_AUTH), but it allows a literal constant
    // argument, so each table name (already read off sqlite_master, never user input) is
    // inlined into its own pragma call rather than bound. Cloudflare's own internal tables
    // (`_cf_METADATA` etc., the same ones `wrangler d1 export` excludes) also raise
    // SQLITE_AUTH from pragma_table_info, so they're filtered out here the same way.
    const master = await t.db.prepare(
      `SELECT name FROM sqlite_master WHERE type = 'table' ` +
        `AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\'`,
    ).all<{ name: string }>();

    const ownedTables: string[] = [];
    for (const { name } of master.results) {
      const columns = await t.db.prepare(
        `SELECT name FROM pragma_table_info('${name}')`,
      ).all<{ name: string }>();
      if (columns.results.some((c) => c.name === "owner")) ownedTables.push(name);
    }
    ownedTables.sort();

    const doc = await store.exportAll(owner, new Date());
    const accounted = [...Object.keys(doc.tables), ...EXPORT_EXCLUDED].sort();
    expect(accounted).toEqual(ownedTables);
  });

  it("is two round trips", async () => {
    await venture("Studios");
    t.resetCount();
    await store.exportAll(owner, new Date());
    expect(t.queries()).toBeLessThanOrEqual(2);
  });
});

describe("tenancy", () => {
  it("the migration makes an existing owner a tenant", async () => {
    const persist = mkdtempSync(join(tmpdir(), "vemi-d1-"));
    const proxy = await getPlatformProxy<{ DB: D1Database }>({
      configPath: join(API_ROOT, "wrangler.jsonc"),
      persist: { path: persist },
      remoteBindings: false,
    });
    try {
      const db = proxy.env.DB;
      const statements = migrationStatements();
      const tenantAt = statements.findIndex((s) => /CREATE TABLE tenant\b/i.test(s));
      expect(tenantAt).toBeGreaterThan(-1);

      // A fixture of rows as they existed before 0006: every earlier migration applied,
      // then a venture row for an owner who has never heard of a `tenant` table.
      for (const sql of statements.slice(0, tenantAt)) await db.prepare(sql).run();
      const legacyOwner = `owner-${crypto.randomUUID()}`;
      await db.prepare(
        `INSERT INTO venture (id, owner, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
      ).bind(crypto.randomUUID(), legacyOwner, "Legacy", "2020-01-01T00:00:00.000Z", "2020-01-01T00:00:00.000Z").run();

      // The rest of 0006 (and anything after it) runs against that fixture.
      for (const sql of statements.slice(tenantAt)) await db.prepare(sql).run();

      const row = await db.prepare(`SELECT id, created_at FROM tenant WHERE id = ?`).bind(legacyOwner).first<{ id: string; created_at: string }>();
      expect(row).toEqual({ id: legacyOwner, created_at: "2020-01-01T00:00:00.000Z" });
    } finally {
      await proxy.dispose();
      rmSync(persist, { recursive: true, force: true });
    }
  });
});

describe("the ledger of decisions and risks", () => {
  const LEDGER = ["decisions", "risks"] as const;
  const setting = async () => {
    const v = await venture("Studios");
    const p = must(await store.create(owner, "projects", { ventureId: v.id, name: "Slice" })).record;
    const made = async (kind: (typeof LEDGER)[number], parent: Record<string, string>, title: string) =>
      must(await store.create(owner, kind, { ...parent, title })).record;
    return { v, p, made };
  };
  const listed = async (kind: Kind) => must(await store.list(owner, kind, {})).map((r) => r.id);

  it("hides with its venture and with its project, and comes back with them", async () => {
    const { v, p, made } = await setting();
    for (const kind of LEDGER) {
      const onVenture = await made(kind, { ventureId: v.id }, "On the venture");
      const onProject = await made(kind, { projectId: p.id }, "On the project");
      expect(await listed(kind)).toEqual(expect.arrayContaining([onVenture.id, onProject.id]));

      must(await store.setArchived(owner, "projects", p.id, true));
      expect(await listed(kind), `${kind} with the project archived`).toEqual([onVenture.id]);
      must(await store.setArchived(owner, "projects", p.id, false));
      expect(await listed(kind)).toEqual(expect.arrayContaining([onVenture.id, onProject.id]));

      must(await store.setArchived(owner, "ventures", v.id, true));
      expect(await listed(kind), `${kind} with the venture archived`).toEqual([]);
      must(await store.setArchived(owner, "ventures", v.id, false));
      expect(await listed(kind)).toEqual(expect.arrayContaining([onVenture.id, onProject.id]));

      for (const r of [onVenture, onProject]) {
        must(await store.setArchived(owner, kind, r.id, true));
        expect(await listed(kind)).not.toContain(r.id);
        must(await store.setArchived(owner, kind, r.id, false));
        expect(await listed(kind)).toContain(r.id);
      }
    }
  });

  it("is counted by a delete, a venture counting its projects' records too, and destroyed by it", async () => {
    const { v, p, made } = await setting();
    const other = await venture("Elsewhere");
    const kept = await made("decisions", { ventureId: other.id }, "Not mine");
    const dVenture = await made("decisions", { ventureId: v.id }, "d venture");
    const dProject = await made("decisions", { projectId: p.id }, "d project");
    const rVenture = await made("risks", { ventureId: v.id }, "r venture");
    const rProject = await made("risks", { projectId: p.id }, "r project");

    must(await store.setArchived(owner, "projects", p.id, true));
    expect((await store.deletePreview(owner, "projects", p.id))?.removes).toMatchObject({ decisions: 1, risks: 1 });
    must(await store.remove(owner, "projects", p.id, "Slice"));
    expect(await store.get(owner, "decisions", dProject.id)).toBeNull();
    expect(await store.get(owner, "risks", rProject.id)).toBeNull();
    expect(await store.get(owner, "decisions", dVenture.id)).not.toBeNull();
    expect(await store.get(owner, "risks", rVenture.id)).not.toBeNull();

    const q = must(await store.create(owner, "projects", { ventureId: v.id, name: "Second" })).record;
    const dSecond = await made("decisions", { projectId: q.id }, "d second");
    const rSecond = await made("risks", { projectId: q.id }, "r second");
    must(await store.setArchived(owner, "ventures", v.id, true));
    const preview = await store.deletePreview(owner, "ventures", v.id);
    expect(preview?.removes).toMatchObject({ decisions: 2, risks: 2 });
    const done = must(await store.remove(owner, "ventures", v.id, "Studios"));
    expect(done.removes).toEqual(preview?.removes);
    for (const [kind, id] of [
      ["decisions", dVenture.id], ["decisions", dSecond.id], ["risks", rVenture.id], ["risks", rSecond.id],
    ] as const) {
      expect(await store.get(owner, kind, id), `${kind} ${id}`).toBeNull();
    }
    expect(await store.get(owner, "decisions", kept.id)).not.toBeNull();
  });

  it("leaves the overview, the tree and today exactly as they were", async () => {
    const { v, p, made } = await setting();
    await task(v.id, "A task", { projectId: p.id, pickedOn: "2026-09-14" });
    const read = async () => ({
      overview: await store.overview(owner),
      tree: await store.tree(owner),
      today: await store.today(owner, "2026-09-14"),
    });
    const before = await read();
    await made("decisions", { ventureId: v.id }, "Ship small");
    await made("risks", { projectId: p.id }, "Rain");
    expect(await read()).toEqual(before);
  });

  it("refuses no parent, both parents, an archived parent and a bad date", async () => {
    const { v, p } = await setting();
    for (const kind of LEDGER) {
      const date = kind === "decisions" ? "decidedOn" : "raisedOn";
      expect(await store.create(owner, kind, { title: "Orphan" })).toMatchObject({ ok: false, status: 400 });
      expect(await store.create(owner, kind, { ventureId: v.id, projectId: p.id, title: "Both" })).toMatchObject({ ok: false, status: 400 });
      expect(await store.create(owner, kind, { ventureId: v.id, title: "Bad", [date]: "soon" })).toMatchObject({ ok: false, status: 400 });
      expect(parseCreate(kind, { title: "Orphan" }).ok).toBe(false);
      expect(parseCreate(kind, { ventureId: v.id, projectId: p.id, title: "Both" }).ok).toBe(false);
      expect(parseCreate(kind, { ventureId: v.id, title: "Bad", [date]: "2026-02-30" }).ok).toBe(false);
      expect(parseCreate(kind, { ventureId: v.id, title: "Good", [date]: "2026-02-28" }).ok).toBe(true);

      must(await store.setArchived(owner, "projects", p.id, true));
      expect(await store.create(owner, kind, { projectId: p.id, title: "Late" })).toMatchObject({ ok: false, status: 404 });
      must(await store.setArchived(owner, "projects", p.id, false));
      must(await store.setArchived(owner, "ventures", v.id, true));
      expect(await store.create(owner, kind, { ventureId: v.id, title: "Late" })).toMatchObject({ ok: false, status: 404 });
      must(await store.setArchived(owner, "ventures", v.id, false));
    }
    expect(await listed("decisions")).toEqual([]);
    expect(await listed("risks")).toEqual([]);
  });
});

describe("the register of links, a description and a size", () => {
  const setting = async () => {
    const v = await venture("Studios");
    const p = must(await store.create(owner, "projects", { ventureId: v.id, name: "Website" })).record;
    const x = await task(v.id, "Write the copy", { projectId: p.id });
    const onVenture = must(await store.create(owner, "links", { ventureId: v.id, url: "https://github.com/a/venture", role: "repo" })).record;
    const onProject = must(await store.create(owner, "links", { projectId: p.id, url: "https://docs.example.com", role: "docs" })).record;
    const onTask = must(await store.create(owner, "links", { taskId: x.id, url: "https://example.com/task" })).record;
    return { v, p, x, onVenture, onProject, onTask };
  };
  const linkIds = async (filter: Record<string, string> = {}) => must(await store.list(owner, "links", filter)).map((l) => l.id).sort();
  const sorted = (...ids: string[]) => [...ids].sort();
  const archive = async (kind: Kind, id: string) => must(await store.setArchived(owner, kind, id, true));
  const restore = async (kind: Kind, id: string) => must(await store.setArchived(owner, kind, id, false));

  it("is listed by its own filter, and a venture's list includes its projects' and tasks' links", async () => {
    const s = await setting();
    expect(await linkIds({ venture: s.v.id })).toEqual(sorted(s.onVenture.id, s.onProject.id, s.onTask.id));
    expect(await linkIds({ project: s.p.id })).toEqual([s.onProject.id]);
    expect(await linkIds({ task: s.x.id })).toEqual([s.onTask.id]);
    expect(s.onTask.role).toBe("other");
    expect([s.onVenture.role, s.onProject.role]).toEqual(["repo", "docs"]);
  });

  it("hides with its venture and with its project, and comes back with them", async () => {
    const s = await setting();
    await archive("projects", s.p.id);
    expect(await linkIds()).toEqual([s.onVenture.id]);
    await restore("projects", s.p.id);
    expect(await linkIds()).toEqual(sorted(s.onVenture.id, s.onProject.id, s.onTask.id));

    await archive("ventures", s.v.id);
    expect(await linkIds()).toEqual([]);
    await restore("ventures", s.v.id);
    expect(await linkIds()).toEqual(sorted(s.onVenture.id, s.onProject.id, s.onTask.id));
  });

  it("is counted by a venture's and a project's delete preview, and destroyed with them", async () => {
    const s = await setting();
    await archive("projects", s.p.id);
    expect((await store.deletePreview(owner, "projects", s.p.id))?.removes.links).toBe(2);
    await restore("projects", s.p.id);

    await archive("ventures", s.v.id);
    expect((await store.deletePreview(owner, "ventures", s.v.id))?.removes.links).toBe(3);
    must(await store.remove(owner, "ventures", s.v.id, "Studios"));
    for (const l of [s.onVenture, s.onProject, s.onTask]) expect(await store.get(owner, "links", l.id)).toBeNull();
  });

  it("destroys a project's own and its tasks' links with the project, and leaves the venture's", async () => {
    const s = await setting();
    await archive("projects", s.p.id);
    must(await store.remove(owner, "projects", s.p.id, "Website"));
    expect(await store.get(owner, "links", s.onProject.id)).toBeNull();
    expect(await store.get(owner, "links", s.onTask.id)).toBeNull();
    expect(await store.get(owner, "links", s.onVenture.id)).not.toBeNull();
  });

  it("refuses no parent, two parents, an archived parent and an unknown role", async () => {
    const s = await setting();
    expect(parseCreate("links", { url: "https://a.example" }).ok).toBe(false);
    expect(parseCreate("links", { ventureId: s.v.id, projectId: s.p.id, url: "https://a.example" }).ok).toBe(false);
    expect(parseCreate("links", { ventureId: s.v.id, url: "https://a.example", role: "boss" }).ok).toBe(false);
    // Past validation the store still refuses a missing parent.
    expect(await store.create(owner, "links", { url: "https://a.example" } as never)).toMatchObject({ ok: false, status: 400 });

    await archive("projects", s.p.id);
    expect(await store.create(owner, "links", { projectId: s.p.id, url: "https://a.example" })).toMatchObject({ ok: false, status: 404 });
    await archive("ventures", s.v.id);
    expect(await store.create(owner, "links", { ventureId: s.v.id, url: "https://a.example" })).toMatchObject({ ok: false, status: 404 });
  });

  it("changes role, url and label by patch", async () => {
    const s = await setting();
    const changed = must(await store.update(owner, "links", s.onVenture.id, { role: "site", url: "https://site.example", label: "Home" })).record;
    expect([changed.role, changed.url, changed.label]).toEqual(["site", "https://site.example", "Home"]);
  });

  it("leaves the overview, the tree and today as they were when one is made on a venture", async () => {
    const v = await venture("Studios");
    await task(v.id, "Picked", { pickedOn: "2026-09-14" });
    const readAll = async () => [await store.overview(owner), await store.tree(owner), await store.today(owner, "2026-09-14")];
    const before = await readAll();
    must(await store.create(owner, "links", { ventureId: v.id, url: "https://github.com/a/b", role: "repo" }));
    expect(await readAll()).toEqual(before);
  });

  it("carries a description on a venture and a project, set, patched and cleared, in the overview, tree and export", async () => {
    const v = await venture("Studios", { description: "Ship a slice" });
    const p = must(await store.create(owner, "projects", { ventureId: v.id, name: "Website", description: "The site" })).record;
    expect(p.description).toBe("The site");

    must(await store.update(owner, "ventures", v.id, { description: "Ship two" }));
    must(await store.update(owner, "projects", p.id, { description: "The new site" }));
    expect((await store.overview(owner)).ventures[0]?.description).toBe("Ship two");
    const tree = (await store.tree(owner)).ventures[0];
    expect([tree?.description, tree?.projects[0]?.description]).toEqual(["Ship two", "The new site"]);

    const doc = await store.exportAll(owner, new Date());
    expect(doc.tables.venture?.[0]?.description).toBe("Ship two");
    expect(doc.tables.project?.[0]?.description).toBe("The new site");
    for (const rows of Object.values(doc.tables)) for (const row of rows) expect(row).not.toHaveProperty("goal");

    expect(must(await store.update(owner, "ventures", v.id, { description: null })).record.description).toBeNull();
    expect(must(await store.update(owner, "projects", p.id, { description: null })).record.description).toBeNull();
  });
});

describe("accounts", () => {
  const FAR = "2999-01-01T00:00:00.000Z";
  const PAST = "2000-01-01T00:00:00.000Z";
  const NOW_ISO = "2026-09-14T02:00:00.000Z";
  const address = () => `person-${crypto.randomUUID()}@example.test`;
  const isTenant = async (id: string) => (await t.db.prepare(`SELECT 1 AS n FROM tenant WHERE id = ?`).bind(id).first()) !== null;
  const newAccount = (over: Partial<Parameters<Store["createAccount"]>[0]> = {}) => ({
    id: owner, email: address(), passwordHash: "hash", googleSub: null, confirmed: false, ...over,
  });
  const token = (over: Partial<Parameters<Store["putEmailToken"]>[0]> = {}) => ({
    id: crypto.randomUUID(), owner, purpose: "invite" as const, email: address(), expiresAt: FAR, ...over,
  });

  it("makes the tenant and the account together, and shows no secret in the view", async () => {
    expect(await isTenant(owner)).toBe(false);
    const email = address();
    expect(await store.createAccount(newAccount({ email }))).toBe(true);
    expect(await isTenant(owner)).toBe(true);
    expect(await store.account(owner)).toMatchObject({
      id: owner, email, confirmed: false, hasPassword: true, google: false, passwordHash: "hash", googleSub: null, generation: 0,
    });
    expect(await store.createAccount(newAccount({ id: `owner-${crypto.randomUUID()}`, email, confirmed: true }))).toBe(false);
  });

  it("keeps an address unique after it is normalised", async () => {
    const email = address();
    expect(await store.createAccount(newAccount({ email }))).toBe(true);
    const other = `owner-${crypto.randomUUID()}`;
    // The row refuses an address that is not already lowercase and trimmed.
    await expect(store.createAccount(newAccount({ id: other, email: ` ${email.toUpperCase()} ` }))).rejects.toThrow();
    // A lookup normalises, so the same person typing it differently finds the same account.
    expect((await store.attempt(` ${email.toUpperCase()} `, [], NOW_ISO, FAR, PAST)).account?.id).toBe(owner);
    expect(await isTenant(other)).toBe(false);
  });

  it("refuses an account with no way in, and one with no real address", async () => {
    await expect(store.createAccount(newAccount({ passwordHash: null, googleSub: null }))).rejects.toThrow();
    await expect(store.createAccount(newAccount({ email: "@example.test" }))).rejects.toThrow();
    expect(await isTenant(owner)).toBe(false);
  });

  it("refuses a second account for the same Google identity or the same owner", async () => {
    const sub = `sub-${crypto.randomUUID()}`;
    expect(await store.createAccount(newAccount({ passwordHash: null, googleSub: sub }))).toBe(true);
    expect(await store.createAccount(newAccount({ id: `owner-${crypto.randomUUID()}`, googleSub: sub }))).toBe(false);
    expect(await store.createAccount(newAccount())).toBe(false);
  });

  it("finds the accounts a Google sign-in could mean, by identity or by address", async () => {
    const sub = `sub-${crypto.randomUUID()}`;
    await store.createAccount(newAccount({ passwordHash: null, googleSub: sub }));
    const byAddress = `owner-${crypto.randomUUID()}`;
    const byAddressEmail = address();
    await store.createAccount(newAccount({ id: byAddress, email: byAddressEmail }));
    expect((await store.accountsForGoogle(sub, "nobody@example.test")).map((a) => a.id)).toEqual([owner]);
    expect((await store.accountsForGoogle("none", byAddressEmail)).map((a) => a.id)).toEqual([byAddress]);
    expect(await store.accountsForGoogle("none", "nobody@example.test")).toEqual([]);
  });

  it("sets a password, ends the sessions and confirms the address only when asked", async () => {
    await store.createAccount(newAccount());
    expect(await store.setPassword(owner, "second", false)).toBe(1);
    expect(await store.account(owner)).toMatchObject({ passwordHash: "second", confirmed: false, generation: 1 });
    expect(await store.setPassword(owner, "third", true)).toBe(2);
    expect(await store.account(owner)).toMatchObject({ passwordHash: "third", confirmed: true, generation: 2 });
    expect(await store.endSessions(owner)).toBe(3);
    expect(await store.setPassword(`owner-${crypto.randomUUID()}`, "x", true)).toBeNull();
    expect(await store.endSessions(`owner-${crypto.randomUUID()}`)).toBeNull();
  });

  it("links and unlinks Google, and will not unlink the only way in", async () => {
    const sub = `sub-${crypto.randomUUID()}`;
    await store.createAccount(newAccount());
    expect(await store.linkGoogle(owner, sub)).toBe(true);
    expect(await store.account(owner)).toMatchObject({ google: true, googleSub: sub });
    expect(await store.unlinkGoogle(owner)).toBe(true);
    expect(await store.account(owner)).toMatchObject({ google: false, googleSub: null });

    const googleOnly = `owner-${crypto.randomUUID()}`;
    await store.createAccount(newAccount({ id: googleOnly, passwordHash: null, googleSub: `sub-${crypto.randomUUID()}` }));
    expect(await store.unlinkGoogle(googleOnly)).toBe(false);
    expect(await store.account(googleOnly)).toMatchObject({ google: true, hasPassword: false });
    // Another account's identity cannot be taken over.
    expect(await store.linkGoogle(owner, (await store.account(googleOnly))?.googleSub ?? "")).toBe(false);
    expect(await store.linkGoogle(`owner-${crypto.randomUUID()}`, sub)).toBe(false);
  });

  it("answers open, ended or gone for a session", async () => {
    await store.createAccount(newAccount());
    expect(await store.sessionHolds(owner, 0)).toBe("open");
    const next = await store.endSessions(owner);
    expect(await store.sessionHolds(owner, 0)).toBe("ended");
    expect(await store.sessionHolds(owner, next ?? -1)).toBe("open");
    expect(await store.sessionHolds(`owner-${crypto.randomUUID()}`, 0)).toBe("gone");
  });

  it("reads the session's row in a read's own round trip, and answers as sessionHolds does", async () => {
    await store.createAccount(newAccount());
    const studios = await venture("Studios");
    await task(studios.id, "A task");

    t.resetCount();
    const open = store.readingAs(owner, 0);
    expect((await open.store.tree(owner)).ventures.map((v) => v.id)).toEqual([studios.id]);
    expect(await open.holds()).toBe("open");
    expect(t.queries()).toBe(1);

    // A read of single statements carries it on the first, and nothing after that.
    t.resetCount();
    const listed = store.readingAs(owner, 0);
    expect(must(await listed.store.list(owner, "tasks", { venture: studios.id })).map((x) => x.title)).toEqual(["A task"]);
    expect(must(await listed.store.list(owner, "tasks", { venture: studios.id }))).toHaveLength(1);
    expect(await listed.holds()).toBe("open");
    expect(t.queries()).toBe(2);

    await store.endSessions(owner);
    const ended = store.readingAs(owner, 0);
    await ended.store.overview(owner);
    expect(await ended.holds()).toBe("ended");

    // Nothing read: the check is asked on its own, once.
    t.resetCount();
    const gone = store.readingAs(`owner-${crypto.randomUUID()}`, 0);
    expect(await gone.holds()).toBe("gone");
    expect(await gone.holds()).toBe("gone");
    expect(t.queries()).toBe(1);
  });

  it("spends a token once, and only for the purpose it was made for", async () => {
    const reset = token({ purpose: "reset" });
    await store.putEmailToken(reset);
    expect(await store.takeEmailToken(reset.id, "invite")).toBeNull();
    expect(await store.takeEmailToken(reset.id, "confirm")).toBeNull();
    expect(await store.takeEmailToken(reset.id, "reset")).toEqual(reset);
    expect(await store.takeEmailToken(reset.id, "reset")).toBeNull();
  });

  it("spends an expired token without handing it over", async () => {
    const old = token({ purpose: "confirm", expiresAt: PAST });
    await store.putEmailToken(old);
    expect(await store.takeEmailToken(old.id, "confirm")).toBeNull();
    expect(await store.takeEmailToken(old.id, "confirm")).toBeNull();
  });

  it("lets a new invite replace the earlier one to the same address, and no other", async () => {
    const email = address();
    const first = token({ email });
    const elsewhere = token();
    const reset = token({ purpose: "reset", email });
    await store.putEmailToken(first);
    await store.putEmailToken(elsewhere);
    await store.putEmailToken(reset);
    const second = token({ email });
    await store.putEmailToken(second);
    expect((await store.invites(owner)).map((i) => i.id).sort()).toEqual([elsewhere.id, second.id].sort());
    expect(await store.takeEmailToken(first.id, "invite")).toBeNull();
    expect(await store.takeEmailToken(reset.id, "reset")).toEqual(reset);
  });

  it("lists only pending, unexpired invitations, and sweeps expired tokens on write", async () => {
    const live = token();
    const dead = token({ expiresAt: PAST });
    await store.putEmailToken(dead);
    await store.putEmailToken(live);
    expect(await store.invites(owner)).toEqual([live]);
    const rows = await t.db.prepare(`SELECT id FROM email_token WHERE id = ?`).bind(dead.id).all();
    expect(rows.results).toEqual([]);
  });

  it("makes the invited account and spends the invite together, or neither", async () => {
    const invite = token();
    await store.putEmailToken(invite);
    expect(await store.pendingToken(invite.id, "invite")).toEqual(invite);

    // The id is taken: nothing is made, and the invite waits as it was.
    await store.createAccount(newAccount());
    const fresh = `owner-${crypto.randomUUID()}`;
    expect(await store.acceptInvite(invite.id, { id: owner, passwordHash: "h", googleSub: null })).toEqual({ made: false, why: "taken" });
    expect(await store.pendingToken(invite.id, "invite")).toEqual(invite);

    t.resetCount();
    expect(await store.acceptInvite(invite.id, { id: fresh, passwordHash: null, googleSub: `sub-${fresh}` })).toEqual({ made: true, email: invite.email });
    expect(t.queries()).toBe(1);
    expect(await isTenant(fresh)).toBe(true);
    expect(await store.account(fresh)).toMatchObject({ email: invite.email, confirmed: true, googleSub: `sub-${fresh}` });
    expect(await store.pendingToken(invite.id, "invite")).toBeNull();
    expect(await store.acceptInvite(invite.id, { id: `owner-${crypto.randomUUID()}`, passwordHash: "h", googleSub: null })).toEqual({ made: false, why: "invalid" });

    // An expired invite makes nothing and is spent all the same.
    const old = token({ expiresAt: PAST });
    await t.db.prepare(`INSERT INTO email_token (id, owner, purpose, email, expires_at, created_at) VALUES (?, ?, 'invite', ?, ?, ?)`)
      .bind(old.id, owner, old.email, PAST, PAST).run();
    const late = `owner-${crypto.randomUUID()}`;
    expect(await store.acceptInvite(old.id, { id: late, passwordHash: "h", googleSub: null })).toEqual({ made: false, why: "invalid" });
    expect(await isTenant(late)).toBe(false);
    expect((await t.db.prepare(`SELECT id FROM email_token WHERE id = ?`).bind(old.id).all()).results).toEqual([]);
  });

  it("withdraws only this owner's waiting invite to the address", async () => {
    const invite = token();
    await store.putEmailToken(invite);
    expect(await store.withdrawInvite(`owner-${crypto.randomUUID()}`, invite.email)).toBe(false);
    expect(await store.withdrawInvite(owner, ` ${invite.email.toUpperCase()} `)).toBe(true);
    expect(await store.invites(owner)).toEqual([]);
    expect(await store.withdrawInvite(owner, invite.email)).toBe(false);
  });

  const rowsOf = async (key: string): Promise<string[]> =>
    (await t.db.prepare(`SELECT at FROM throttle WHERE key = ? ORDER BY at`).bind(key).all<{ at: string }>()).results.map((r) => r.at);

  it("counts an attempt against every key until one is at its limit inside the window, then counts none", async () => {
    const a = `ip:${crypto.randomUUID()}`;
    const b = `acct:${crypto.randomUUID()}`;
    const limits = [{ key: a, limit: 3 }, { key: b, limit: 2 }];
    const since = "2026-09-14T00:30:00.000Z";
    expect((await store.attempt(null, [{ key: a, limit: 3 }], "2026-09-14T00:00:00.000Z", since, PAST)).reserved).toHaveLength(1);
    // The 00:00 row is outside the window, so a has none in it: both keys are under.
    expect((await store.attempt(null, limits, "2026-09-14T01:00:00.000Z", since, PAST)).reserved).toHaveLength(2);
    expect((await store.attempt(null, limits, "2026-09-14T01:01:00.000Z", since, PAST)).reserved).toHaveLength(2);
    // b is at two: nothing is counted against either key.
    expect((await store.attempt(null, limits, "2026-09-14T01:02:00.000Z", since, PAST)).reserved).toBeNull();
    expect(await rowsOf(a)).toEqual(["2026-09-14T00:00:00.000Z", "2026-09-14T01:00:00.000Z", "2026-09-14T01:01:00.000Z"]);
    expect(await rowsOf(b)).toHaveLength(2);

    // Sweeping before 00:30 takes the 00:00 row and leaves the 01:00 ones.
    await store.attempt(null, [], "2026-09-14T02:00:00.000Z", since, "2026-09-14T00:30:00.000Z");
    expect(await rowsOf(a)).toEqual(["2026-09-14T01:00:00.000Z", "2026-09-14T01:01:00.000Z"]);
  });

  it("holds attempts sent all at once to the limit", async () => {
    const key = `ip:${crypto.randomUUID()}`;
    const answers = await Promise.all(Array.from({ length: 20 }, (_, n) =>
      store.attempt(null, [{ key, limit: 5 }], `2026-09-14T01:00:${String(n).padStart(2, "0")}.000Z`, PAST, PAST)));
    expect(answers.filter((x) => x.reserved !== null)).toHaveLength(5);
    expect(await rowsOf(key)).toHaveLength(5);
  });

  it("reads the account with the attempt in one round trip, and forgets a key and the rows it reserved", async () => {
    const email = address();
    const key = `acct:${crypto.randomUUID()}`;
    const ip = `ip:${crypto.randomUUID()}`;
    await store.createAccount(newAccount({ email }));
    await store.attempt(null, [{ key, limit: 5 }, { key: ip, limit: 5 }], "2026-09-14T01:00:00.000Z", PAST, PAST);
    t.resetCount();
    const found = await store.attempt(email, [{ key, limit: 5 }, { key: ip, limit: 5 }], "2026-09-14T01:01:00.000Z", PAST, PAST);
    expect(t.queries()).toBe(1);
    expect(found.account?.id).toBe(owner);
    expect(found.reserved).toHaveLength(2);
    expect((await store.attempt(address(), [], NOW_ISO, PAST, PAST)).account).toBeNull();

    // Every row of the key goes, and of the other key only the row this attempt reserved.
    await store.forgetAttempts([key], found.reserved ?? []);
    expect(await rowsOf(key)).toEqual([]);
    expect(await rowsOf(ip)).toEqual(["2026-09-14T01:00:00.000Z"]);
    await store.forgetAttempts([], []);
    expect(await rowsOf(ip)).toHaveLength(1);
  });
});

describe("no limits", () => {
  const free = () => t.db.prepare(
    "INSERT INTO tenant (id, created_at, plan) VALUES (?1, ?2, 'free') ON CONFLICT (id) DO UPDATE SET plan = 'free'",
  ).bind(owner, "2026-09-14T02:00:00Z").run();

  it("lets a free account hold five ventures and move a nested one out", async () => {
    await free();
    const made = [];
    for (const name of ["One", "Two", "Three", "Four", "Five"]) made.push(await venture(name));
    const inner = await venture("Inner", { parentId: made[0]!.id });
    expect(must(await store.update(owner, "ventures", inner.id, { parentId: null })).record.parentId).toBeNull();
    const top = await t.db.prepare("SELECT COUNT(*) AS n FROM venture WHERE owner = ? AND parent_id IS NULL")
      .bind(owner).first<{ n: number }>();
    expect(top?.n).toBe(6);
    const plan = await t.db.prepare("SELECT plan FROM tenant WHERE id = ?").bind(owner).first<{ plan: string }>();
    expect(plan?.plan).toBe("free");
  });

  it("lets a free account fill a venture with a project and a task", async () => {
    await free();
    const v = await venture("Filled");
    must(await store.create(owner, "projects", { ventureId: v.id, name: "P Filled" }));
    must(await store.create(owner, "tasks", { ventureId: v.id, title: "T Filled" }));
  });
});
