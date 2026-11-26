import { describe, expect, it } from "vitest";
import type { State, StateKind, TaskWithBlocker, TreeProject, TreeVenture } from "@vemi/shared";
import { columnsFor, type Column } from "./boardGroups.js";
import { moveAcross, sameColumns, stepInColumn, withMoves, type Moved } from "./boardMoves.js";

const AT = "2026-09-01T00:00:00.000Z";
const recorded = (id: string) => ({ id, createdAt: AT, updatedAt: AT, archivedAt: null });

const state = (id: string, ventureId: string, kind: StateKind, position: number): State =>
  ({ ...recorded(id), ventureId, name: id, kind, position });

const task = (id: string, ventureId: string, over: Partial<TaskWithBlocker> = {}): TaskWithBlocker => ({
  ...recorded(id), ventureId, projectId: null, milestoneId: null, stateId: null, title: id, body: null,
  checklist: [], priority: null, dueOn: null, pickedOn: null, position: 0, todayPosition: null, remindAt: null, repeat: null,
  blocker: null, tagIds: [], ...over,
});

const project = (id: string, ventureId: string, name: string, position: number, tasks: TaskWithBlocker[]): TreeProject => ({
  ...recorded(id), ventureId, name, icon: null, description: null, position, parentId: null, stageId: null, atRisk: false, pinnedAt: null, whoFor: null, doneLooks: null, openQuestions: null,
  blocked: false, tagIds: [], milestones: [], tasks,
});

const venture = (id: string, over: Partial<TreeVenture> = {}): TreeVenture => ({
  ...recorded(id), name: id, icon: null, description: null, position: 0, parentId: null,
  views: ["board", "projects"], monogram: null,
  stageId: null, atRisk: false, stages: [], blocked: false,
  states: [state(`${id}-idea`, id, "not_started", 0), state(`${id}-making`, id, "underway", 1)],
  projects: [], tasks: [], ...over,
});

/** A move as the board records one, at a moment that has not settled. */
const madeAt = (grouping: Moved["grouping"], keys: readonly string[], fields: Moved["fields"]): Moved =>
  ({ grouping, keys, fields, at: Date.now() });

/** What is in each column, by key: the only thing most of these tests care about. */
const who = (columns: readonly Column[]) => Object.fromEntries(columns.map((c) => [c.key, c.tasks.map((t) => t.id)]));

/** The card as the board is drawing it now, which is what a second drag has to read. */
const onScreen = (columns: readonly Column[], id: string): TaskWithBlocker => {
  const found = columns.flatMap((c) => c.tasks).find((t) => t.id === id);
  if (found === undefined) throw new Error(`no card ${id} on this board`);
  return found;
};

const ops = (): TreeProject => project("p1", "v", "Ops", 0, [task("a", "v", { projectId: "p1", milestoneId: "m1" })]);

describe("moveAcross: the drop table", () => {
  const v = venture("v", { projects: [ops(), project("p2", "v", "Studio", 1, [])] });

  it("project writes the project, and the milestone with it", () => {
    const columns = columnsFor(v, "project");
    const made = moveAcross(onScreen(columns, "a"), "p2", columns);
    expect(made.fields).toEqual({ projectId: "p2", milestoneId: null });
    expect(made.keys).toEqual(["p2"]);
    expect(made.name).toBe("Studio");
  });

  it("project onto the none column writes null, not the empty string", () => {
    const columns = columnsFor(v, "project");
    const made = moveAcross(onScreen(columns, "a"), "", columns);
    expect(made.fields).toEqual({ projectId: null, milestoneId: null });
    expect(made.name).toBe("No project");
  });

  it("the state grouping has no none column, so there is no empty key to write", () => {
    // A state drop is the board's own path: it writes `stateId` and a `position`, and it can
    // never be handed `""`, because `columnsFor` makes no none column for states.
    const columns = columnsFor(venture("v", { tasks: [task("q", "v")] }), "state");
    expect(columns.map((c) => c.key)).toEqual(["v-idea", "v-making"]);
    expect(who(columns)).toEqual({ "v-idea": ["q"], "v-making": [] });
  });
});

describe("moveAcross: the way back", () => {
  it("a project move restores the project and the milestone it could not keep", () => {
    // Forward the Worker nulls the milestone whether or not it is named, because a
    // milestone belongs to a project. A way back naming only the project would clear it
    // a second time, and there would be nothing left to go back to.
    const v = venture("v", { projects: [ops(), project("p2", "v", "Studio", 1, [])] });
    const columns = columnsFor(v, "project");
    const made = moveAcross(onScreen(columns, "a"), "p2", columns);
    expect(made.was).toEqual({ projectId: "p1", milestoneId: "m1" });
  });
});

describe("withMoves", () => {
  const v = venture("v", { projects: [ops(), project("p2", "v", "Studio", 1, [])] });

  it("leaves the columns alone when nothing is pending", () => {
    const columns = columnsFor(v, "project");
    expect(who(withMoves(columns, new Map(), "project"))).toEqual(who(columns));
  });

  it("puts the card in the column it was dropped on before the tree says so", () => {
    const columns = columnsFor(v, "project");
    const moved = new Map([["a", madeAt("project", ["p2"], { projectId: "p2" })]]);
    expect(who(withMoves(columns, moved, "project"))).toEqual({ p1: [], p2: ["a"], "": [] });
  });

  it("carries the move's own fields onto the card, not only its column", () => {
    const columns = columnsFor(v, "project");
    const moved = new Map([["a", madeAt("project", ["p2"], { projectId: "p2" })]]);
    expect(onScreen(withMoves(columns, moved, "project"), "a").projectId).toBe("p2");
  });

  it("does not apply a move made under another grouping", () => {
    // A move's columns mean nothing under a grouping that did not make them.
    const moved = new Map([["a", madeAt("project", ["p2"], { projectId: "p2" })]]);
    const columns = columnsFor(v, "state");
    expect(who(withMoves(columns, moved, "state"))).toEqual(who(columns));
    expect(onScreen(withMoves(columns, moved, "state"), "a").projectId).toBe("p1");
  });
});

describe("two quick drags, which is the whole reason any of this is pure", () => {
  it("two quick project drags each restore their own project and milestone", () => {
    const v = venture("v", {
      projects: [ops(), project("p2", "v", "Studio", 1, []), project("p3", "v", "Field", 2, [])],
    });
    const columns = columnsFor(v, "project");

    const first = moveAcross(onScreen(columns, "a"), "p2", columns);
    const moved = new Map([["a", madeAt("project", first.keys, first.fields)]]);
    const after = withMoves(columns, moved, "project");

    const second = moveAcross(onScreen(after, "a"), "p3", after);
    expect(second.was).toEqual({ projectId: "p2", milestoneId: null });
    expect(first.was).toEqual({ projectId: "p1", milestoneId: "m1" });
  });
});

describe("sameColumns", () => {
  it("is true for the same keys in any order", () => {
    expect(sameColumns(["a", "b"], ["b", "a"])).toBe(true);
  });

  it("is false when either side has a column the other does not", () => {
    expect(sameColumns(["a"], ["a", "b"])).toBe(false);
    expect(sameColumns(["a", "b"], ["a"])).toBe(false);
  });
});

describe("stepInColumn: moving a card by keyboard", () => {
  const all = ["a", "b", "c", "d"];

  it("goes before the card above, and after the card below", () => {
    expect(stepInColumn(all, all, "c", -1)).toBe("b");
    expect(stepInColumn(all, all, "b", 1)).toBe("d");
    expect(stepInColumn(all, all, "c", 1)).toBeNull();
  });

  it("has nowhere to go past either end", () => {
    expect(stepInColumn(all, all, "a", -1)).toBeUndefined();
    expect(stepInColumn(all, all, "d", 1)).toBeUndefined();
  });

  it("steps over the cards on screen, not the ones a filter hides", () => {
    // b is hidden: moving c up lands it above a, the shown card above it.
    expect(stepInColumn(all, ["a", "c", "d"], "c", -1)).toBe("a");
    // Moving a down lands it after c, the shown card below, so before d.
    expect(stepInColumn(all, ["a", "c", "d"], "a", 1)).toBe("d");
    expect(stepInColumn(all, ["a", "c"], "a", 1)).toBe("d");
  });

  it("does nothing for a card that is not drawn", () => {
    expect(stepInColumn(all, ["a", "c"], "b", 1)).toBeUndefined();
  });
});
