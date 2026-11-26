import { describe, expect, it } from "vitest";
import type { DateFilters, SearchHit, SearchKind } from "@vemi/shared";
import {
  RECENT_SEARCHES_KEY, RECENT_SEARCHES_MOST, SHORTCUTS_EVENT, filterCards, onShortcutsEvent, groupHits, readRecentSearches, rememberSearch,
  scopeCounts, scopeOf, scoped, writeRecentSearches, type CardTask,
} from "./searchState.js";

const hit = (kind: SearchKind, id: string): SearchHit => ({ kind, id, ventureId: "v", projectId: null, taskId: null, text: id });
const ALL = [hit("venture", "a"), hit("project", "b"), hit("milestone", "c"), hit("task", "d"), hit("task", "e"), hit("note", "f"), hit("decision", "g"), hit("risk", "h"), hit("link", "i")];

describe("scope", () => {
  it("puts spaces, projects and milestones under projects, and the four kinds of record under notes", () => {
    expect(scopeOf("venture")).toBe("projects");
    expect(scopeOf("project")).toBe("projects");
    expect(scopeOf("milestone")).toBe("projects");
    expect(scopeOf("task")).toBe("tasks");
    for (const k of ["note", "decision", "risk", "link"] as const) expect(scopeOf(k)).toBe("notes");
  });
  it("keeps every hit for All and only its own for a scope, in order", () => {
    expect(scoped(ALL, "all")).toHaveLength(9);
    expect(scoped(ALL, "tasks").map((h) => h.id)).toEqual(["d", "e"]);
    expect(scoped(ALL, "projects").map((h) => h.id)).toEqual(["a", "b", "c"]);
    expect(scoped(ALL, "notes").map((h) => h.id)).toEqual(["f", "g", "h", "i"]);
  });
  it("counts each scope, All being the sum", () => {
    expect(scopeCounts(ALL)).toEqual({ all: 9, projects: 3, tasks: 2, notes: 4 });
    expect(scopeCounts([])).toEqual({ all: 0, projects: 0, tasks: 0, notes: 0 });
  });
  it("groups projects, then tasks, then notes, each with its count, and leaves out the empty", () => {
    const groups = groupHits(ALL, "all");
    expect(groups.map((g) => [g.scope, g.hits.length])).toEqual([["projects", 3], ["tasks", 2], ["notes", 4]]);
    expect(groupHits(ALL, "tasks").map((g) => g.scope)).toEqual(["tasks"]);
    expect(groupHits([hit("task", "x")], "notes")).toEqual([]);
  });
});

describe("recent searches", () => {
  it("puts the newest first and keeps five", () => {
    let list: readonly string[] = [];
    for (const q of ["a", "b", "c", "d", "e", "f"]) list = rememberSearch(list, q);
    expect(list).toEqual(["f", "e", "d", "c", "b"]);
    expect(list).toHaveLength(RECENT_SEARCHES_MOST);
  });
  it("moves a repeat to the front, case blind, and keeps the newest spelling", () => {
    expect(rememberSearch(["b", "Alpha", "c"], "alpha")).toEqual(["alpha", "b", "c"]);
  });
  it("trims, and ignores nothing typed", () => {
    expect(rememberSearch(["a"], "   ")).toEqual(["a"]);
    expect(rememberSearch(["a"], "  b ")).toEqual(["b", "a"]);
  });
  it("reads what is kept, and nothing when it is missing, broken or blocked", () => {
    expect(RECENT_SEARCHES_KEY).toBe("vemi:recentSearches:v1");
    expect(readRecentSearches({ getItem: () => JSON.stringify(["x", "y"]) })).toEqual(["x", "y"]);
    expect(readRecentSearches({ getItem: () => null })).toEqual([]);
    expect(readRecentSearches({ getItem: () => "{nope" })).toEqual([]);
    expect(readRecentSearches({ getItem: () => JSON.stringify([1, "ok", ""]) })).toEqual(["ok"]);
    expect(readRecentSearches({ getItem: () => { throw new Error("blocked"); } })).toEqual([]);
  });
  it("writes the list, and says nothing when the browser will not keep it", () => {
    let kept: [string, string] | null = null;
    writeRecentSearches(["a", "b"], { setItem: (k, v) => { kept = [k, v]; } });
    expect(kept).toEqual([RECENT_SEARCHES_KEY, '["a","b"]']);
    expect(() => writeRecentSearches(["a"], { setItem: () => { throw new Error("full"); } })).not.toThrow();
  });
});

const AT = "2026-11-18T00:00:00.000Z";
const task = (id: string, over: Partial<CardTask> = {}): CardTask => ({
  id, createdAt: AT, updatedAt: AT, archivedAt: null, ventureId: "v", projectId: null, milestoneId: null, stateId: null,
  title: id, body: null, checklist: [], priority: null, dueOn: null, pickedOn: null, position: 0, todayPosition: null,
  remindAt: null, repeat: null, finished: false, where: "", ...over,
});

describe("filter cards", () => {
  const tasks = [
    task("late", { dueOn: "2026-11-10", where: "Home" }),
    task("soon", { dueOn: "2026-11-20", where: "Work" }),
    task("ding", { remindAt: "2026-11-19T09:00" }),
    task("loop", { repeat: "weekly" }),
    task("fin", { finished: true }),
    task("gone", { dueOn: "2026-11-01", archivedAt: AT }),
    task("Pay the vet", { where: "Home" }),
  ];
  // What the Worker answers: the client never works out which tasks these are.
  const dates: DateFilters = { on: "2026-11-18", before: [tasks[0]!], week: [tasks[1]!] };
  it("lists the two date cards first from the server answer, then the rest, then the person's own", () => {
    const cards = filterCards(tasks, dates, [{ id: "f1", name: "Vet things", query: "vet" }]);
    expect(cards.map((c) => [c.name, c.count])).toEqual([
      ["Overdue", 1], ["Due this week", 1], ["Has a reminder", 1], ["Repeating", 1], ["Done", 1], ["Vet things", 1],
    ]);
    expect(cards.slice(0, 5).every((c) => !c.own)).toBe(true);
    expect(cards[5]).toMatchObject({ own: true, id: "f1" });
  });
  it("takes the date lists as given and does not look at a due date itself", () => {
    const cards = filterCards(tasks, { on: "2026-11-18", before: [tasks[1]!], week: [] }, []);
    expect(cards[0]?.tasks.map((t) => t.id)).toEqual(["soon"]);
    expect(cards[1]).toMatchObject({ count: 0, tasks: [] });
  });
  it("lists a date card's tasks with where each sits", () => {
    const cards = filterCards(tasks, dates, []);
    expect(cards[0]?.tasks.map((t) => [t.id, t.where])).toEqual([["late", "Home"]]);
    expect(cards[1]?.tasks.map((t) => [t.id, t.where])).toEqual([["soon", "Work"]]);
  });
  it("shows no count and no tasks on the two date cards when the Worker has not answered", () => {
    const cards = filterCards(tasks, null, []);
    expect(cards.slice(0, 2).map((c) => [c.name, c.count, c.tasks.length])).toEqual([["Overdue", null, 0], ["Due this week", null, 0]]);
    expect(cards.slice(2).map((c) => c.count)).toEqual([1, 1, 1]);
  });
  it("lists a card's tasks, never an archived one", () => {
    const cards = filterCards(tasks.map((t) => (t.id === "fin" ? { ...t, archivedAt: AT } : t)), dates, []);
    expect(cards[4]?.tasks).toEqual([]);
  });
  it("matches an own filter on the title or where it sits, by words in any order", () => {
    const cards = filterCards(tasks, dates, [{ id: "f", name: "x", query: "home vet" }]);
    expect(cards.at(-1)?.tasks.map((t) => t.id)).toEqual(["Pay the vet"]);
  });
  it("is zero for an own filter that matches nothing", () => {
    expect(filterCards(tasks, dates, [{ id: "f", name: "x", query: "zzz" }]).at(-1)?.count).toBe(0);
  });
});

describe("onShortcutsEvent", () => {
  it("runs on the shortcuts event and stops after it is released", () => {
    const target = new EventTarget();
    let opened = 0;
    const stop = onShortcutsEvent(target, () => { opened += 1; });
    target.dispatchEvent(new Event(SHORTCUTS_EVENT));
    expect(opened).toBe(1);
    stop();
    target.dispatchEvent(new Event(SHORTCUTS_EVENT));
    expect(opened).toBe(1);
  });
});
