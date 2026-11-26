import { describe, expect, it } from "vitest";
import type { Overview, Today, Tree, TreeProject, TreeVenture } from "@vemi/shared";
import { hiddenProjects, PLATE_ROWS, plates } from "./plates.js";

// Fixtures carry only what the plates read.
const task = (id: string, finished = false) => ({ id, stateId: finished ? "done" : "open" });
const project = (id: string, over: Partial<Record<string, unknown>> = {}): TreeProject => ({
  id, ventureId: "s1", name: id, position: 0, pinnedAt: null, blocked: false, atRisk: false, stageId: null, tasks: [],
  ...over,
}) as unknown as TreeProject;
const space = (id: string, over: Partial<Record<string, unknown>> = {}): TreeVenture => ({
  id, name: id, icon: null, blocked: false, atRisk: false, stageId: null, projects: [], tasks: [],
  stages: [{ id: "st", name: "Building" }],
  states: [{ id: "open", kind: "underway" }, { id: "done", kind: "finished" }],
  ...over,
}) as unknown as TreeVenture;
const overview = (rows: readonly (readonly [string, string | null, number])[]): Overview => ({
  ventures: rows.map(([id, parentId, position]) => ({ id, name: id, parentId, position })),
  archivedVentures: 0,
}) as unknown as Overview;
const todayOf = (tasks: readonly { id: string; picked?: boolean; overdue?: boolean }[]): Today =>
  ({ on: "2026-11-16", tasks: tasks.map((t) => ({ picked: false, overdue: false, ...t })) }) as unknown as Today;

describe("plates", () => {
  it("counts tasks left and done across a space's projects and loose tasks", () => {
    const tree: Tree = { ventures: [space("s1", {
      tasks: [task("a")],
      projects: [project("p1", { tasks: [task("b"), task("c", true)] })],
    })] };
    const [plate] = plates(overview([["s1", null, 0]]), tree, null);
    expect(plate?.counts).toEqual({ left: 2, done: 1 });
    expect(plate?.projects[0]).toMatchObject({ left: 1, done: 1 });
  });

  it("holds every project and caps what shows at three", () => {
    const tree: Tree = { ventures: [space("s1", { projects: ["a", "b", "c", "d", "e"].map((id, i) => project(id, { position: i })) })] };
    const [plate] = plates(overview([["s1", null, 0]]), tree, null);
    expect(plate?.projects).toHaveLength(5);
    expect(PLATE_ROWS).toBe(3);
    expect(hiddenProjects(plate?.projects ?? [])).toBe(2);
    expect(hiddenProjects([1, 2, 3])).toBe(0);
  });

  it("puts pinned projects first, then position", () => {
    const tree: Tree = { ventures: [space("s1", { projects: [
      project("a", { position: 1 }),
      project("b", { position: 2, pinnedAt: "2026-11-10T00:00:00Z" }),
      project("c", { position: 0 }),
    ] })] };
    const [plate] = plates(overview([["s1", null, 0]]), tree, null);
    expect(plate?.projects.map((p) => p.id)).toEqual(["b", "c", "a"]);
    expect(plate?.projects[0]?.pinned).toBe(true);
  });

  it("nests a space inside its parent's plate and counts it in the parent's ring", () => {
    const tree: Tree = { ventures: [
      space("s1", { tasks: [task("a")] }),
      space("s2", { tasks: [task("b"), task("c")] }),
    ] };
    const out = plates(overview([["s1", null, 0], ["s2", "s1", 1]]), tree, null);
    expect(out.map((p) => p.id)).toEqual(["s1"]);
    expect(out[0]?.inner.map((p) => p.id)).toEqual(["s2"]);
    expect(out[0]?.counts.left).toBe(3);
    expect(out[0]?.inner[0]?.counts.left).toBe(2);
  });

  it("orders plates by position and names the stage", () => {
    const tree: Tree = { ventures: [space("s1", { stageId: "st" }), space("s2")] };
    const out = plates(overview([["s1", null, 5], ["s2", null, 1]]), tree, null);
    expect(out.map((p) => p.id)).toEqual(["s2", "s1"]);
    expect(out[1]?.stage).toBe("Building");
    expect(out[0]?.stage).toBeNull();
  });

  it("shows flags blocked, then overdue, then at risk, and no more than two", () => {
    const tree: Tree = { ventures: [space("s1", {
      blocked: true, atRisk: true, projects: [project("p1", { tasks: [task("late")] })],
    })] };
    const [plate] = plates(overview([["s1", null, 0]]), tree, todayOf([{ id: "late", overdue: true }]));
    expect(plate?.flags).toEqual(["blocked", "overdue"]);
  });

  it("shows overdue before at risk, and an at-risk project's flag on its row", () => {
    const tree: Tree = { ventures: [space("s1", { projects: [
      project("p1", { atRisk: true, tasks: [task("late")] }),
      project("p2", { atRisk: true }),
    ] })] };
    const [plate] = plates(overview([["s1", null, 0]]), tree, todayOf([{ id: "late", overdue: true }]));
    expect(plate?.flags).toEqual(["overdue", "at risk"]);
    expect(plate?.projects.map((p) => p.flag)).toEqual(["overdue", "at risk"]);
  });

  it("lets a nested space's flags reach its parent", () => {
    const tree: Tree = { ventures: [space("s1"), space("s2", { blocked: true })] };
    const [plate] = plates(overview([["s1", null, 0], ["s2", "s1", 1]]), tree, null);
    expect(plate?.flags).toEqual(["blocked"]);
  });

  it("marks a project with a task picked for today", () => {
    const tree: Tree = { ventures: [space("s1", { projects: [
      project("p1", { tasks: [task("t1")] }), project("p2", { tasks: [task("t2")] }),
    ] })] };
    const [plate] = plates(overview([["s1", null, 0]]), tree, todayOf([{ id: "t1", picked: true }]));
    expect(plate?.projects.map((p) => p.onToday)).toEqual([true, false]);
  });
});
