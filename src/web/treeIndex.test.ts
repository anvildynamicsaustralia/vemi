import { describe, expect, it } from "vitest";
import type { State, StateKind, TaskWithBlocker, Today, TodayTask, Tree, TreeProject, TreeVenture } from "@vemi/shared";
import { fallbackState, firstOfKind, indexTree, kindOf, needsYou, nextPosition, pickable } from "./treeIndex.js";

const AT = "2026-09-01T00:00:00.000Z";
const recorded = (id: string) => ({ id, createdAt: AT, updatedAt: AT, archivedAt: null });

const state = (id: string, ventureId: string, kind: StateKind, position: number): State =>
  ({ ...recorded(id), ventureId, name: id, kind, position });

const task = (id: string, ventureId: string, over: Partial<TaskWithBlocker> = {}): TaskWithBlocker => ({
  ...recorded(id), ventureId, projectId: null, milestoneId: null, stateId: null, title: id, body: null,
  checklist: [], priority: null, dueOn: null, pickedOn: null, position: 0, todayPosition: null, remindAt: null, repeat: null, 
  blocker: null, tagIds: [], ...over,
});

const blocker = (taskId: string) => ({ ...recorded(`b-${taskId}`), taskId, reason: "waiting", waitsOnTaskId: null, person: null, sinceOn: null });

const project = (id: string, ventureId: string, tasks: TaskWithBlocker[]): TreeProject => ({
  ...recorded(id), ventureId, name: id, icon: null, description: null, position: 0, parentId: null, stageId: null, atRisk: false, pinnedAt: null, whoFor: null, doneLooks: null, openQuestions: null,
  blocked: false, tagIds: [], milestones: [], tasks,
});

const venture = (id: string, over: Partial<TreeVenture> = {}): TreeVenture => ({
  ...recorded(id), name: id, icon: null, description: null, position: 0, parentId: null,
  views: ["board", "projects"], monogram: null,
  stageId: null, atRisk: false, stages: [],
  blocked: false,
  states: [state(`${id}-todo`, id, "not_started", 0), state(`${id}-doing`, id, "underway", 1), state(`${id}-done`, id, "finished", 2)],
  projects: [], tasks: [], ...over,
});

describe("indexTree", () => {
  const tree: Tree = {
    ventures: [
      venture("child", { parentId: "parent", position: 0 }),
      venture("parent", { position: 1, projects: [project("p1", "parent", [task("in-project", "parent", { projectId: "p1" })])], tasks: [task("loose", "parent")] }),
      venture("other", { position: 2 }),
    ],
  };
  const index = indexTree(tree);

  it("puts children beneath their parent and keeps them out of the top level", () => {
    expect(index.top.map((v) => v.id)).toEqual(["parent", "other"]);
    expect(index.ordered.map((v) => v.id)).toEqual(["parent", "child", "other"]);
    expect(index.children.get("parent")?.map((v) => v.id)).toEqual(["child"]);
  });

  it("finds a task wherever it sits, with its venture and project", () => {
    expect(index.tasks.get("loose")?.project).toBeNull();
    expect(index.tasks.get("in-project")?.project?.id).toBe("p1");
    expect(index.tasks.get("in-project")?.venture.id).toBe("parent");
  });

  it("gives a venture no children it was not given", () => {
    expect(index.children.get("other")).toBeUndefined();
  });
});

// The columns themselves are `boardGroups.test.ts`'s, which also holds them against the
// board's old `boardColumns` for every fixture that was ever proved on. What is left here is
// the rule the columns are built from: the state a task with none of its own falls into.
describe("the state a task falls into", () => {
  it("is the first not-started one, whatever order the states are held in", () => {
    const v = venture("v", {
      states: [state("done", "v", "finished", 2), state("idea", "v", "not_started", 0), state("making", "v", "underway", 1)],
      tasks: [task("no-state", "v"), task("made", "v", { stateId: "done" }), task("going", "v", { stateId: "making" })],
    });
    expect(kindOf(task("x", "v"), v)).toBe("not_started");
    expect(firstOfKind(v, "finished")?.id).toBe("done");
    expect(fallbackState(v)?.id).toBe("idea");
  });

  it("falls back to the first state there is when none is not-started, and to nothing when there are none", () => {
    const working = venture("working", {
      states: [state("done", "working", "finished", 1), state("making", "working", "underway", 0)],
    });
    expect(fallbackState(working)?.id).toBe("making");
    expect(fallbackState(venture("empty", { states: [] }))).toBeNull();
  });
});

describe("needsYou", () => {
  const v = venture("v", {
    tasks: [
      task("stuck", "v", { blocker: blocker("stuck") }),
      task("stuck-but-done", "v", { stateId: "v-done", blocker: blocker("stuck-but-done") }),
      task("late", "v", { dueOn: "2026-09-01" }),
      task("late-and-stuck", "v", { dueOn: "2026-09-01", blocker: blocker("late-and-stuck") }),
      task("fine", "v"),
    ],
  });
  const index = indexTree({ ventures: [v] });
  const todayTask = (t: TaskWithBlocker, overdue: boolean): TodayTask => ({ ...t, stateKind: null, picked: false, overdue });
  const today: Today = {
    on: "2026-09-14",
    tasks: [todayTask(index.tasks.get("late")!.task, true), todayTask(index.tasks.get("late-and-stuck")!.task, true)],
  };

  it("is overdue and blocked, and nothing else", () => {
    expect(needsYou(index, today).map((a) => [a.kind, a.task.id])).toEqual([
      ["overdue", "late"], ["blocked", "stuck"], ["blocked", "late-and-stuck"],
    ]);
  });

  it("still shows what is blocked before today has loaded", () => {
    expect(needsYou(index, null).map((a) => a.task.id)).toEqual(["stuck", "late-and-stuck"]);
  });
});

describe("pickable", () => {
  it("offers unfinished, unblocked tasks not already picked, and stops at the limit", () => {
    const v = venture("v", {
      tasks: [
        task("a", "v"), task("picked", "v", { pickedOn: "2026-09-14" }), task("old-pick", "v", { pickedOn: "2026-09-13" }),
        task("done", "v", { stateId: "v-done" }), task("blocked", "v", { blocker: blocker("blocked") }), task("b", "v"),
      ],
    });
    const index = indexTree({ ventures: [v] });
    expect(pickable(index, "2026-09-14").map((l) => l.task.id)).toEqual(["a", "old-pick", "b"]);
    expect(pickable(index, "2026-09-14", 2).map((l) => l.task.id)).toEqual(["a", "old-pick"]);
  });
});

describe("nextPosition", () => {
  it("is one past the end, and one for an empty list", () => {
    expect(nextPosition([])).toBe(1);
    expect(nextPosition([{ position: 3 }, { position: 7 }])).toBe(8);
  });
});
