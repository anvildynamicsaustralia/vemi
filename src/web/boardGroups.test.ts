import { describe, expect, it } from "vitest";
import type { State, StateKind, TaskWithBlocker, TreeProject, TreeVenture } from "@vemi/shared";
import { columnsFor, type Column, type Grouping } from "./boardGroups.js";
import { fallbackState, orderedStates, stateOf, tasksOf } from "./treeIndex.js";

/**
 * `boardColumns` as `treeIndex.ts` held it before the board read `columnsFor` and it was
 * deleted: a column per state, a stateless task in the fallback one. Kept here, and not in
 * the tree's index where nothing would call it, so the proof below still has the thing it
 * proves `columnsFor(venture, "state")` equal to.
 */
const asTheBoardDrew = (venture: TreeVenture): { state: State; tasks: TaskWithBlocker[] }[] => {
  const fallback = fallbackState(venture);
  const all = tasksOf(venture);
  return orderedStates(venture).map((state) => ({
    state,
    tasks: all.filter((t) => (stateOf(t, venture) ?? fallback)?.id === state.id),
  }));
};

const AT = "2026-09-01T00:00:00.000Z";
const recorded = (id: string) => ({ id, createdAt: AT, updatedAt: AT, archivedAt: null });

const state = (id: string, ventureId: string, kind: StateKind, position: number): State =>
  ({ ...recorded(id), ventureId, name: id, kind, position });

const task = (id: string, ventureId: string, over: Partial<TaskWithBlocker> = {}): TaskWithBlocker => ({
  ...recorded(id), ventureId, projectId: null, milestoneId: null, stateId: null, title: id, body: null,
  checklist: [], priority: null, dueOn: null, pickedOn: null, position: 0, todayPosition: null, remindAt: null, repeat: null,
  blocker: null, tagIds: [], ...over,
});

const project = (id: string, ventureId: string, position: number, tasks: TaskWithBlocker[]): TreeProject => ({
  ...recorded(id), ventureId, name: id, icon: null, description: null, position, parentId: null, stageId: null, atRisk: false, pinnedAt: null, whoFor: null, doneLooks: null, openQuestions: null,
  blocked: false, tagIds: [], milestones: [], tasks,
});

const venture = (id: string, over: Partial<TreeVenture> = {}): TreeVenture => ({
  ...recorded(id), name: id, icon: null, description: null, position: 0, parentId: null,
  views: ["board", "projects"], monogram: null,
  stageId: null, atRisk: false, stages: [], blocked: false,
  states: [state(`${id}-todo`, id, "not_started", 0), state(`${id}-doing`, id, "underway", 1), state(`${id}-done`, id, "finished", 2)],
  projects: [], tasks: [], ...over,
});

/** A column read the way a test reads it: what it is keyed by, what it is called, its dot, and who is in it. */
const shape = (columns: readonly Column[]) => columns.map((c) => [c.key, c.name, c.kind, c.tasks.map((t) => t.id)]);

describe("columnsFor, grouping by state", () => {
  it("is a column per state in the venture's order, a stateless task in the first not-started", () => {
    const v = venture("v", {
      states: [state("done", "v", "finished", 2), state("idea", "v", "not_started", 0), state("making", "v", "underway", 1)],
      tasks: [task("no-state", "v"), task("made", "v", { stateId: "done" }), task("going", "v", { stateId: "making" })],
    });
    expect(shape(columnsFor(v, "state"))).toEqual([
      ["idea", "idea", "not_started", ["no-state"]],
      ["making", "making", "underway", ["going"]],
      ["done", "done", "finished", ["made"]],
    ]);
  });

  it("is the same columns the board already drew, for every fixture those were proved on", () => {
    const ventures = [
      venture("plain", { tasks: [task("a", "plain"), task("b", "plain", { stateId: "plain-done" })] }),
      venture("shuffled", {
        states: [state("done", "shuffled", "finished", 2), state("idea", "shuffled", "not_started", 0), state("making", "shuffled", "underway", 1)],
        tasks: [task("no-state", "shuffled"), task("made", "shuffled", { stateId: "done" }), task("going", "shuffled", { stateId: "making" })],
      }),
      venture("in-projects", {
        projects: [project("p1", "in-projects", 0, [task("deep", "in-projects", { projectId: "p1", stateId: "in-projects-doing" })])],
        tasks: [task("loose", "in-projects")],
      }),
      venture("no-not-started", {
        states: [state("making", "no-not-started", "underway", 0), state("done", "no-not-started", "finished", 1)],
        tasks: [task("homeless", "no-not-started")],
      }),
      venture("stateless", { states: [], tasks: [task("nowhere", "stateless")] }),
    ];
    for (const v of ventures) {
      expect(columnsFor(v, "state").map((c) => [c.key, c.tasks.map((t) => t.id)]))
        .toEqual(asTheBoardDrew(v).map((c) => [c.state.id, c.tasks.map((t) => t.id)]));
    }
  });

  it("has no none column: a task without a state falls into a real one", () => {
    const v = venture("v", { tasks: [task("no-state", "v")] });
    expect(columnsFor(v, "state").some((c) => c.key === "")).toBe(false);
  });
});

describe("columnsFor, grouping by project", () => {
  const v = venture("v", {
    projects: [
      project("later", "v", 2, [task("in-later", "v", { projectId: "later" })]),
      project("first", "v", 0, [task("in-first", "v", { projectId: "first" })]),
      project("empty", "v", 1, []),
    ],
    tasks: [task("loose", "v")],
  });

  it("is a column per project in the venture's own order, with No project last", () => {
    expect(shape(columnsFor(v, "project"))).toEqual([
      ["first", "first", null, ["in-first"]],
      ["empty", "empty", null, []],
      ["later", "later", null, ["in-later"]],
      ["", "No project", null, ["loose"]],
    ]);
  });

  it("follows a parent with its children, each headed Parent › Child", () => {
    const nest = venture("n", {
      projects: [
        { ...project("kid", "n", 0, [task("in-kid", "n", { projectId: "kid" })]), parentId: "b" },
        project("a", "n", 1, []),
        project("b", "n", 2, [task("in-b", "n", { projectId: "b" })]),
      ],
      tasks: [task("loose", "n")],
    });
    expect(shape(columnsFor(nest, "project"))).toEqual([
      ["a", "a", null, []],
      ["b", "b", null, ["in-b"]],
      ["kid", "b › kid", null, ["in-kid"]],
      ["", "No project", null, ["loose"]],
    ]);
  });

  it("is No project alone in a venture with no projects", () => {
    const bare = venture("bare", { tasks: [task("one", "bare"), task("two", "bare")] });
    expect(shape(columnsFor(bare, "project"))).toEqual([["", "No project", null, ["one", "two"]]]);
  });
});

describe("columnsFor, whatever the grouping", () => {
  const v = venture("v", {
    projects: [project("p1", "v", 0, [task("in-p1", "v", { projectId: "p1", })])],
    tasks: [task("loose", "v"), task("second", "v")],
  });
  const grouped: readonly Grouping[] = ["project"];

  it("puts the none column last and nowhere else", () => {
    for (const grouping of grouped) {
      const columns = columnsFor(v, grouping);
      expect(columns.filter((c) => c.key === "")).toHaveLength(1);
      expect(columns[columns.length - 1]?.key).toBe("");
    }
  });

  it("draws a dot only under state, the one grouping whose column names one", () => {
    expect(columnsFor(v, "state").every((c) => c.kind !== null)).toBe(true);
    for (const grouping of grouped) expect(columnsFor(v, grouping).every((c) => c.kind === null)).toBe(true);
  });

  it("holds every task of the venture", () => {
    for (const grouping of ["state", ...grouped] as readonly Grouping[]) {
      const shown = columnsFor(v, grouping).flatMap((c) => c.tasks.map((t) => t.id));
      expect([...shown].sort()).toEqual(["in-p1", "loose", "second"]);
    }
  });
});
