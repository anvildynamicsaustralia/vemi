import { describe, expect, it } from "vitest";
import type { State, TaskWithBlocker, Tree, TreeMilestone, TreeProject, TreeVenture } from "@vemi/shared";
import { recentItems } from "./recentItems.js";

const OLD = "2026-09-01T00:00:00.000Z";
const recorded = (id: string, updatedAt = OLD) => ({ id, createdAt: OLD, updatedAt, archivedAt: null });

const state = (id: string, ventureId: string): State =>
  ({ ...recorded(id), ventureId, name: id, kind: "not_started", position: 0 });

const task = (id: string, ventureId: string, updatedAt = OLD, over: Partial<TaskWithBlocker> = {}): TaskWithBlocker => ({
  ...recorded(id, updatedAt), ventureId, projectId: null, milestoneId: null, stateId: null, title: `task ${id}`, body: null,
  checklist: [], priority: null, dueOn: null, pickedOn: null, position: 0, todayPosition: null, remindAt: null, repeat: null, 
  blocker: null, tagIds: [], ...over,
});

const milestone = (id: string, projectId: string, updatedAt = OLD): TreeMilestone =>
  ({ ...recorded(id, updatedAt), projectId, stateId: null, name: `milestone ${id}`, aimingOn: null, position: 0, blocked: false });

const project = (id: string, ventureId: string, updatedAt = OLD, over: Partial<TreeProject> = {}): TreeProject => ({
  ...recorded(id, updatedAt), ventureId, name: `project ${id}`, icon: null, description: null, position: 0, parentId: null, stageId: null, atRisk: false, pinnedAt: null, whoFor: null, doneLooks: null, openQuestions: null,
  blocked: false, tagIds: [], milestones: [], tasks: [], ...over,
});

const venture = (id: string, updatedAt = OLD, over: Partial<TreeVenture> = {}): TreeVenture => ({
  ...recorded(id, updatedAt), name: `venture ${id}`, icon: null, description: null, position: 0, parentId: null,
  views: ["board", "projects"], monogram: null,
  stageId: null, atRisk: false, stages: [],
  blocked: false, states: [state(`${id}-todo`, id)], projects: [], tasks: [], ...over,
});

const at = (minute: number): string => `2026-09-20T10:${String(minute).padStart(2, "0")}:00.000Z`;
const ids = (rows: readonly { readonly id: string }[]): string[] => rows.map((r) => r.id);

describe("recentItems", () => {
  it("puts the newest first", () => {
    const tree: Tree = {
      ventures: [venture("v", at(1), {
        tasks: [task("t1", "v", at(5)), task("t2", "v", at(3))],
        projects: [project("p", "v", at(4))],
      })],
    };
    expect(ids(recentItems(tree, 8))).toEqual(["t1", "t2"]);
  });

  it("breaks a tie by id, so the order holds still", () => {
    const tree: Tree = {
      ventures: [venture("v", OLD, { tasks: [task("b", "v", at(2)), task("c", "v", at(2)), task("a", "v", at(2))] })],
    };
    expect(ids(recentItems(tree, 3))).toEqual(["a", "b", "c"]);
  });

  it("gives a milestone and a task with the same stamp the same order every time", () => {
    const tree: Tree = {
      ventures: [venture("v", OLD, {
        projects: [project("p", "v", OLD, {
          milestones: [milestone("m", "p", at(7))],
          tasks: [task("k", "v", at(7), { projectId: "p" })],
        })],
      })],
    };
    const first = ids(recentItems(tree, 2));
    expect(first).toEqual(["k"]);
    const reversed: Tree = {
      ventures: [venture("v", OLD, {
        projects: [project("p", "v", OLD, {
          tasks: [task("k", "v", at(7), { projectId: "p" })],
          milestones: [milestone("m", "p", at(7))],
        })],
      })],
    };
    expect(ids(recentItems(reversed, 2))).toEqual(first);
  });

  it("honours most", () => {
    const tree: Tree = {
      ventures: [venture("v", at(0), { tasks: [1, 2, 3, 4, 5].map((n) => task(`t${n}`, "v", at(n))) })],
    };
    expect(ids(recentItems(tree, 2))).toEqual(["t5", "t4"]);
    expect(recentItems(tree, 0)).toEqual([]);
    expect(recentItems(tree, 50)).toHaveLength(5);
  });

  it("answers nothing for an empty tree", () => {
    expect(recentItems({ ventures: [] }, 8)).toEqual([]);
  });

  it("reads a venture with no projects", () => {
    const tree: Tree = { ventures: [venture("v", at(3), { tasks: [task("t", "v", at(4))] })] };
    expect(recentItems(tree, 8)).toEqual([
      { id: "t", kind: "task", title: "task t", ventureId: "v", projectName: null, at: at(4) },
    ]);
  });

  it("lists tasks only, each with its project name, and none for a loose task", () => {
    const tree: Tree = {
      ventures: [
        venture("v", at(9), {
          tasks: [task("loose", "v", at(2))],
          projects: [project("p", "v", at(8), {
            milestones: [milestone("m", "p", at(7))],
            tasks: [task("inner", "v", at(5), { projectId: "p", milestoneId: "m" })],
          })],
        }),
        venture("w", at(6)),
      ],
    };
    expect(recentItems(tree, 8).map((r) => [r.id, r.kind, r.ventureId, r.projectName])).toEqual([
      ["inner", "task", "v", "project p"],
      ["loose", "task", "v", null],
    ]);
  });

  it("lists the last six when asked for six", () => {
    const tree: Tree = {
      ventures: [venture("v", OLD, { tasks: [1, 2, 3, 4, 5, 6, 7, 8].map((n) => task(`t${n}`, "v", at(n))) })],
    };
    expect(ids(recentItems(tree, 6))).toEqual(["t8", "t7", "t6", "t5", "t4", "t3"]);
  });

  it("keeps a finished task that was just touched: done is not out of sight", () => {
    const finished: State = { ...state("v-done", "v"), kind: "finished", position: 1 };
    const tree: Tree = {
      ventures: [venture("v", OLD, {
        states: [state("v-todo", "v"), finished],
        tasks: [task("open", "v", at(3), { stateId: "v-todo" }), task("done", "v", at(8), { stateId: "v-done" })],
      })],
    };
    expect(ids(recentItems(tree, 2))).toEqual(["done", "open"]);
  });

  describe("via", () => {
    const change = (recordId: string, createdAt: string, over: Partial<{ clientName: string; undoneAt: string | null; kind: string }> = {}) =>
      ({ recordId, kind: "tasks", clientName: "Claude", createdAt, undoneAt: null, ...over });

    it("names the app that touched a task last", () => {
      const tree: Tree = { ventures: [venture("v", OLD, { tasks: [task("t", "v", at(5))] })] };
      expect(recentItems(tree, 3, [change("t", at(5))])[0]?.via).toBe("Claude");
    });

    it("says nothing once the person touched it after", () => {
      const tree: Tree = { ventures: [venture("v", OLD, { tasks: [task("t", "v", at(9))] })] };
      expect(recentItems(tree, 3, [change("t", at(5))])[0]?.via).toBeUndefined();
    });

    it("says nothing for a change that was undone", () => {
      const tree: Tree = { ventures: [venture("v", OLD, { tasks: [task("t", "v", at(6))] })] };
      expect(recentItems(tree, 3, [change("t", at(5), { undoneAt: at(6) })])[0]?.via).toBeUndefined();
    });

    it("takes the newest app when two touched it, and ignores other kinds", () => {
      const tree: Tree = { ventures: [venture("v", OLD, { tasks: [task("t", "v", at(8))] })] };
      const via = recentItems(tree, 3, [
        change("t", at(6), { clientName: "ChatGPT" }), change("t", at(8)), change("t", at(8), { kind: "notes", clientName: "Other" }),
      ])[0]?.via;
      expect(via).toBe("Claude");
    });
  });
});
