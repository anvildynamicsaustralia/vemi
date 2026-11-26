import { describe, expect, it } from "vitest";
import type { State, StateKind, TaskWithBlocker, Today, TodayTask, Tree, TreeMilestone, TreeProject, TreeVenture } from "@vemi/shared";
import { comingUp } from "./comingUp.js";

const AT = "2026-09-01T00:00:00.000Z";
const recorded = (id: string) => ({ id, createdAt: AT, updatedAt: AT, archivedAt: null });

const state = (id: string, ventureId: string, kind: StateKind, position: number): State =>
  ({ ...recorded(id), ventureId, name: id, kind, position });

const task = (id: string, ventureId: string, over: Partial<TaskWithBlocker> = {}): TaskWithBlocker => ({
  ...recorded(id), ventureId, projectId: null, milestoneId: null, stateId: null, title: id, body: null,
  checklist: [], priority: null, dueOn: null, pickedOn: null, position: 0, todayPosition: null, remindAt: null, repeat: null, 
  blocker: null, tagIds: [], ...over,
});

const milestone = (id: string, projectId: string, over: Partial<TreeMilestone> = {}): TreeMilestone =>
  ({ ...recorded(id), projectId, stateId: null, name: id, aimingOn: null, position: 0, blocked: false, ...over });

const project = (id: string, ventureId: string, over: Partial<TreeProject> = {}): TreeProject => ({
  ...recorded(id), ventureId, name: id, icon: null, description: null, position: 0, parentId: null, stageId: null, atRisk: false, pinnedAt: null, whoFor: null, doneLooks: null, openQuestions: null,
  blocked: false, tagIds: [], milestones: [], tasks: [], ...over,
});

const venture = (id: string, over: Partial<TreeVenture> = {}): TreeVenture => ({
  ...recorded(id), name: id, icon: null, description: null, position: 0, parentId: null,
  views: ["board", "projects"], monogram: null,
  stageId: null, atRisk: false, stages: [],
  blocked: false,
  states: [state(`${id}-todo`, id, "not_started", 0), state(`${id}-done`, id, "finished", 2)],
  projects: [], tasks: [], ...over,
});

const todayFor = (tasks: readonly TaskWithBlocker[], flagged: readonly string[]): Today => ({
  on: "2026-09-14",
  tasks: tasks.map((t): TodayTask => ({ ...t, stateKind: null, picked: false, overdue: flagged.includes(t.id) })),
});

const ids = (rows: readonly { readonly id: string }[]): string[] => rows.map((r) => r.id);

describe("comingUp", () => {
  it("gathers a venture's own dated tasks, its projects' dated tasks, and its milestones", () => {
    const tree: Tree = {
      ventures: [venture("v", {
        tasks: [task("loose", "v", { dueOn: "2026-09-16" })],
        projects: [project("p", "v", {
          tasks: [task("in-project", "v", { projectId: "p", dueOn: "2026-09-17" })],
          milestones: [milestone("m", "p", { aimingOn: "2026-10-01" })],
        })],
      })],
    };
    expect(comingUp(tree, null)).toEqual([
      { id: "loose", kind: "task", date: "2026-09-16", ventureId: "v", title: "loose", overdue: false },
      { id: "in-project", kind: "task", date: "2026-09-17", ventureId: "v", title: "in-project", overdue: false },
      { id: "m", kind: "milestone", date: "2026-10-01", ventureId: "v", title: "m", overdue: false },
    ]);
  });

  it("leaves out a finished task", () => {
    const tree: Tree = {
      ventures: [venture("v", {
        tasks: [task("done", "v", { dueOn: "2026-09-16", stateId: "v-done" }), task("going", "v", { dueOn: "2026-09-16" })],
      })],
    };
    expect(ids(comingUp(tree, null))).toEqual(["going"]);
  });

  it("leaves out a finished milestone, however long ago it was aimed at", () => {
    const tree: Tree = {
      ventures: [venture("v", {
        projects: [project("p", "v", {
          milestones: [
            milestone("shipped", "p", { aimingOn: "2026-01-01", stateId: "v-done" }),
            milestone("aiming", "p", { aimingOn: "2026-10-01" }),
          ],
        })],
      })],
    };
    expect(ids(comingUp(tree, null))).toEqual(["aiming"]);
  });

  it("leaves out anything with no date: a task with no date is not coming, it is waiting", () => {
    const tree: Tree = {
      ventures: [venture("v", {
        tasks: [task("dateless", "v"), task("dated", "v", { dueOn: "2026-09-16" })],
        projects: [project("p", "v", { milestones: [milestone("no-date", "p"), milestone("aimed", "p", { aimingOn: "2026-10-01" })] })],
      })],
    };
    expect(ids(comingUp(tree, null))).toEqual(["dated", "aimed"]);
  });

  it("carries the overdue flag across from /api/today by id, and never works one out", () => {
    const flagged = task("flagged", "v", { dueOn: "2026-09-02" });
    const quiet = task("quiet", "v", { dueOn: "2026-09-02" });
    const tree: Tree = { ventures: [venture("v", { tasks: [flagged, quiet] })] };
    const rows = comingUp(tree, todayFor([flagged, quiet], ["flagged"]));
    expect(rows.map((r) => [r.id, r.overdue])).toEqual([["flagged", true], ["quiet", false]]);
  });

  it("never marks a milestone overdue, whatever the day says", () => {
    const tree: Tree = {
      ventures: [venture("v", { projects: [project("p", "v", { milestones: [milestone("m", "p", { aimingOn: "2026-01-05" })] })] })],
    };
    expect(comingUp(tree, todayFor([], [])).map((r) => r.overdue)).toEqual([false]);
  });

  it("reads every venture, not one", () => {
    const tree: Tree = {
      ventures: [
        venture("a", { tasks: [task("from-a", "a", { dueOn: "2026-09-16" })] }),
        venture("b", { tasks: [task("from-b", "b", { dueOn: "2026-09-16" })] }),
      ],
    };
    expect(comingUp(tree, null).map((r) => [r.id, r.ventureId])).toEqual([["from-a", "a"], ["from-b", "b"]]);
  });

  it("gives nothing for a tree with nothing in it", () => {
    expect(comingUp({ ventures: [] }, null)).toEqual([]);
  });
});
