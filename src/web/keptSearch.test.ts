import { describe, expect, it } from "vitest";
import type { Decision, Link, Note, Risk, State, TaskWithBlocker, Tree, TreeProject, TreeVenture } from "@vemi/shared";
import { SEARCH_MOST } from "@vemi/shared";
import { searchAddress, searchesKept, searchKept, searchSaid, searchSettled, type DeviceLists, type SearchReads } from "./keptSearch.js";

const OLD = "2026-09-01T00:00:00.000Z";
const recorded = (id: string) => ({ id, createdAt: OLD, updatedAt: OLD, archivedAt: null });

const state = (id: string, ventureId: string): State =>
  ({ ...recorded(id), ventureId, name: id, kind: "not_started", position: 0 });

const task = (id: string, ventureId: string, title: string, projectId: string | null = null): TaskWithBlocker => ({
  ...recorded(id), ventureId, projectId, milestoneId: null, stateId: null, title, body: null,
  checklist: [], priority: null, dueOn: null, pickedOn: null, position: 0, todayPosition: null, remindAt: null, repeat: null, 
  blocker: null, tagIds: [],
});

const project = (id: string, ventureId: string, name: string, tasks: TaskWithBlocker[] = []): TreeProject => ({
  ...recorded(id), ventureId, name, icon: null, description: null, position: 0, parentId: null, stageId: null, atRisk: false, pinnedAt: null, whoFor: null, doneLooks: null, openQuestions: null,
  blocked: false, tagIds: [], milestones: [], tasks,
});

const venture = (id: string, name: string, over: Partial<TreeVenture> = {}): TreeVenture => ({
  ...recorded(id), name, icon: null, description: null, position: 0, parentId: null,
  views: ["board", "projects"], monogram: null,
  stageId: null, atRisk: false, stages: [],
  blocked: false, states: [state(`${id}-todo`, id)], projects: [], tasks: [], ...over,
});

const tree: Tree = {
  ventures: [
    venture("farm", "Fence Farm", {
      tasks: [task("t1", "farm", "Order fence posts")],
      projects: [project("p1", "farm", "Fence repairs", [task("t2", "farm", "Dig the fence line", "p1")])],
    }),
    venture("studio", "Studio", { projects: [project("p2", "studio", "Copy")] }),
  ],
};

describe("searchKept", () => {
  const hit = (kind: string, id: string, ventureId: string, projectId: string | null, taskId: string | null, text: string) =>
    ({ kind, id, ventureId, projectId, taskId, text });

  it("finds ventures, projects and tasks by name, case-blind, in the Worker's order", () => {
    expect(searchKept(tree, "FENCE")).toEqual([
      hit("venture", "farm", "farm", null, null, "Fence Farm"),
      hit("project", "p1", "farm", "p1", null, "Fence repairs"),
      hit("task", "t2", "farm", "p1", "t2", "Dig the fence line"),
      hit("task", "t1", "farm", null, "t1", "Order fence posts"),
    ]);
  });

  it("finds a task inside a project, and says the venture and project it is in", () => {
    expect(searchKept(tree, "dig")).toEqual([hit("task", "t2", "farm", "p1", "t2", "Dig the fence line")]);
  });

  it("finds a task by its body or a step, and a milestone by its name", () => {
    const deep: Tree = {
      ventures: [venture("v", "V", {
        tasks: [{ ...task("a", "v", "Call"), body: "About the kestrel" }, { ...task("b", "v", "Ship"), checklist: [{ text: "Kestrel reel", done: false }] }],
        projects: [{ ...project("p", "v", "Slice"), milestones: [{ ...recorded("m"), projectId: "p", stateId: null, name: "Kestrel alpha", aimingOn: null, position: 0, blocked: false }] }],
      })],
    };
    expect(searchKept(deep, "kestrel").map((h) => [h.kind, h.id])).toEqual([["milestone", "m"], ["task", "a"], ["task", "b"]]);
  });

  it("finds nothing for nothing typed, and nothing that is not there", () => {
    expect(searchKept(tree, "   ")).toEqual([]);
    expect(searchKept(tree, "harvest")).toEqual([]);
  });

  it("stops each kind at its own allowance, as the Worker does, so tasks never crowd out a venture", () => {
    const many: Tree = { ventures: [venture("v", "Row house", { tasks: Array.from({ length: 60 }, (_, i) => task(`t${i}`, "v", `row ${i}`)) })] };
    const found = searchKept(many, "row");
    expect(found[0]?.kind).toBe("venture");
    expect(found.filter((h) => h.kind === "task")).toHaveLength(SEARCH_MOST.task);
  });
});

describe("searchKept on a device that holds the lists", () => {
  const SEALED = `v1.${"A".repeat(11)}.${"B".repeat(16)}.${"C".repeat(40)}`;
  const note = (id: string, body: string, over: Partial<Note> = {}): Note =>
    ({ ...recorded(id), ventureId: null, projectId: "p1", body, ...over });
  const decision = (id: string, title: string, over: Partial<Decision> = {}): Decision =>
    ({ ...recorded(id), ventureId: "farm", projectId: null, title, body: null, decidedOn: null, position: 0, ...over });
  const risk = (id: string, title: string, body: string | null = null): Risk =>
    ({ ...recorded(id), ventureId: null, projectId: "p2", title, body, raisedOn: null, position: 0 });
  const link = (id: string, over: Partial<Link>): Link =>
    ({ ...recorded(id), ventureId: null, projectId: null, taskId: null, url: "https://example.com", label: null, role: "other" as Link["role"], ...over });

  const lists: DeviceLists = {
    notes: [
      note("n1", "The fence needs treated posts"),
      note("n2", "Posts arrive Friday", { projectId: null, ventureId: "farm" }),
      note("gone", "Fence on a hidden project", { projectId: "archived" }),
    ],
    decisions: [decision("d1", "Use treated pine"), decision("d2", "Gate", { body: "Pine, not steel" })],
    risks: [risk("r1", "Pine price rises", "supplier says"), risk("r2", "Rain delays")],
    links: [
      link("l1", { taskId: "t1", url: "https://example.com/pine", label: "Pine supplier" }),
      link("l2", { projectId: "p2", url: "https://pine.example.com" }),
    ],
  };

  const brief: Tree = {
    ventures: [
      venture("farm", "Fence Farm", {
        tasks: [task("t1", "farm", "Order fence posts")],
        projects: [{ ...project("p1", "farm", "Fence repairs"), whoFor: "Neighbours on the pine ridge" }],
      }),
      venture("studio", "Studio", { projects: [project("p2", "studio", "Copy")] }),
    ],
  };

  const ids = (hits: { kind: string; id: string }[]) => hits.map((h) => `${h.kind}:${h.id}`);

  it("finds notes, decisions, risks and links beside the tree, in the Worker's kind order", () => {
    expect(ids(searchKept(brief, "pine", lists))).toEqual([
      "project:p1", "decision:d1", "decision:d2", "risk:r1", "link:l1", "link:l2",
    ]);
  });

  it("lists a link by its label, else its address, and a note cut as the archive cuts it", () => {
    const found = searchKept(brief, "pine", lists);
    expect(found.find((h) => h.id === "l1")?.text).toBe("Pine supplier");
    expect(found.find((h) => h.id === "l2")?.text).toBe("https://pine.example.com");
    const long = searchKept(brief, "end", { ...lists, notes: [note("n9", `${"x".repeat(130)} end`)] });
    expect(long[0]?.text).toHaveLength(120);
  });

  it("says where a risk, a link and a note sit, from their project or task when they name no space", () => {
    const found = searchKept(brief, "pine", lists);
    expect(found.find((h) => h.id === "r1")).toMatchObject({ ventureId: "studio", projectId: "p2" });
    expect(found.find((h) => h.id === "l1")).toMatchObject({ ventureId: "farm", projectId: null, taskId: "t1" });
    expect(found.find((h) => h.id === "l2")).toMatchObject({ ventureId: "studio", projectId: "p2" });
    expect(searchKept(brief, "posts", lists).find((h) => h.id === "n1")).toMatchObject({ ventureId: "farm", projectId: "p1" });
  });

  it("finds a note, and leaves out one whose project is not on screen", () => {
    expect(ids(searchKept(brief, "fence", lists)).filter((i) => i.startsWith("note"))).toEqual(["note:n1"]);
  });

  it("finds a project by its brief, but never by an envelope or the word Locked", () => {
    expect(ids(searchKept(brief, "ridge"))).toEqual(["project:p1"]);
    const closed: Tree = { ventures: [venture("v", "V", { tasks: [{ ...task("a", "v", "Locked"), body: SEALED }] })] };
    expect(searchKept(closed, "lock")).toEqual([]);
    expect(searchKept(closed, "AAAA")).toEqual([]);
  });

  it("orders a note by the whole of its body and lists the cut", () => {
    const body = `${"y".repeat(125)} kestrel`;
    const found = searchKept(brief, "kestrel", { ...lists, notes: [note("late", body), note("early", "Kestrel first")] });
    expect(found.map((h) => h.id)).toEqual(["early", "late"]);
  });

  it("stops notes at their own allowance", () => {
    const many = Array.from({ length: 30 }, (_, i) => note(`n${i}`, `kestrel ${i}`));
    expect(searchKept(brief, "kestrel", { ...lists, notes: many })).toHaveLength(SEARCH_MOST.note);
  });

  it("finds the same tree hits with empty lists as without them", () => {
    expect(searchKept(brief, "fence")).toEqual(searchKept(brief, "fence", { notes: [], decisions: [], risks: [], links: [] }));
  });
});

describe("searchAddress", () => {
  it("asks the Worker for a plain account and nothing at all for an encrypted one", () => {
    const at = (q: string): string => `/api/search?q=${q}`;
    expect(searchAddress("pine", false, at)).toBe("/api/search?q=pine");
    expect(searchAddress("pine", true, at)).toBeNull();
    expect(searchAddress("", false, at)).toBeNull();
  });
});

describe("what the search sheet says", () => {
  const asked: SearchReads = { query: "plan", needle: "plan", loading: false, answered: false, error: null, unreached: false, kept: null, hits: 0 };

  it("searches the kept tree only with no connection and no answer yet", () => {
    expect(searchesKept("plan", false, true)).toBe(true);
    expect(searchesKept("plan", true, true)).toBe(false);
    expect(searchesKept("plan", false, false)).toBe(false);
    expect(searchesKept("", false, true)).toBe(false);
  });

  it("says nothing when the field is empty, where the filter cards speak", () => {
    expect(searchSaid({ ...asked, query: "", needle: "" })).toEqual({ said: "", nothing: false, failed: null });
  });

  it("is looking while the field is ahead of the ask or the read is running", () => {
    expect(searchSaid({ ...asked, query: "plans" }).said).toBe("Looking…");
    expect(searchSaid({ ...asked, loading: true }).said).toBe("Looking…");
  });

  it("is settled only once the answer is for the field as it is now", () => {
    // Typed ahead of the debounce: what is listed is the last search's, so Enter must wait.
    expect(searchSettled({ ...asked, query: "plans", answered: true })).toBe(false);
    expect(searchSettled({ ...asked, answered: true, loading: true })).toBe(false);
    expect(searchSettled(asked)).toBe(false);
    expect(searchSettled({ ...asked, answered: true })).toBe(true);
    expect(searchSettled({ ...asked, error: "search is resting" })).toBe(true);
    expect(searchSettled({ ...asked, kept: 0 })).toBe(true);
  });

  it("says a failed search once, and not as still looking, when nothing was kept", () => {
    expect(searchSaid({ ...asked, error: "Failed to fetch", unreached: true }))
      .toEqual({ said: "Search needs a connection.", nothing: false, failed: null });
    expect(searchSaid({ ...asked, error: "search is resting" }))
      .toEqual({ said: "search is resting", nothing: false, failed: null });
  });

  it("says what the kept tree found, with no failure beside it", () => {
    expect(searchSaid({ ...asked, error: "Failed to fetch", unreached: true, kept: 2, hits: 2 }))
      .toEqual({ said: "No connection: searching what this device kept. 2 found", nothing: false, failed: null });
    expect(searchSaid({ ...asked, error: "Failed to fetch", unreached: true, kept: 0, hits: 0 }).nothing).toBe(true);
  });

  it("counts the Worker's answer, and keeps it on screen under a later failure", () => {
    expect(searchSaid({ ...asked, answered: true, hits: 3 })).toEqual({ said: "3 found", nothing: false, failed: null });
    expect(searchSaid({ ...asked, answered: true }).nothing).toBe(true);
    expect(searchSaid({ ...asked, answered: true, hits: 3, error: "Failed to fetch", unreached: true }).failed)
      .toBe("Search needs a connection.");
  });
});
