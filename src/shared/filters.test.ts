import { describe, expect, it } from "vitest";
import { BUILT_IN_FILTERS, type FilterTask } from "./filters.js";

function task(id: string, over: Partial<FilterTask> = {}): FilterTask {
  return {
    id,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    archivedAt: null,
    ventureId: "v1",
    projectId: null,
    milestoneId: null,
    stateId: null,
    title: id,
    body: null,
    checklist: [],
    priority: null,
    dueOn: null,
    pickedOn: null,
    position: 0,
    todayPosition: null,
    remindAt: null,
    repeat: null,
    finished: false,
    ...over,
  };
}

function pass(name: string, t: FilterTask): boolean {
  const f = BUILT_IN_FILTERS.find((x) => x.name === name);
  if (!f) throw new Error(name);
  return f.test(t);
}

describe("built-in filters", () => {
  it("keeps the three that need no date, in order", () => {
    expect(BUILT_IN_FILTERS.map((f) => f.name)).toEqual(["Has a reminder", "Repeating", "Done"]);
  });

  it("Has a reminder, Repeating and Done read their own field", () => {
    expect(pass("Has a reminder", task("a", { remindAt: "2026-11-19T09:00" }))).toBe(true);
    expect(pass("Has a reminder", task("a"))).toBe(false);
    expect(pass("Repeating", task("a", { repeat: "week:1" }))).toBe(true);
    expect(pass("Repeating", task("a"))).toBe(false);
    expect(pass("Done", task("a", { finished: true }))).toBe(true);
    expect(pass("Done", task("a"))).toBe(false);
  });

  it("does not look at a due date", () => {
    expect(BUILT_IN_FILTERS.some((f) => f.test(task("a", { dueOn: "2020-01-01" })))).toBe(false);
  });
});
