import { describe, expect, it } from "vitest";
import type { Today, TodayTask } from "@vemi/shared";
import { todayCounts } from "./todayCounts.js";

const task = (id: string, picked: boolean, overdue: boolean): TodayTask => ({
  id, createdAt: "", updatedAt: "", archivedAt: null, ventureId: "v", projectId: null, milestoneId: null,
  stateId: null, title: id, body: null, checklist: [], priority: null, dueOn: null, pickedOn: null,
  position: 0, todayPosition: null, remindAt: null, repeat: null, blocker: null, tagIds: [], stateKind: null, picked, overdue,
});

describe("todayCounts", () => {
  it("counts what the Today list shows: picked tasks, and overdue tasks that are not picked", () => {
    const today: Today = {
      on: "2026-11-16",
      tasks: [task("a", true, false), task("b", true, true), task("c", false, true), task("d", false, true)],
    };
    // The two filters ui/Today.tsx:37-38 uses on one value.
    const picked = today.tasks.filter((t) => t.picked);
    const overdue = today.tasks.filter((t) => t.overdue && !t.picked);
    expect(todayCounts(today)).toEqual({ on: picked.length, overdue: overdue.length });
    expect(todayCounts(today)).toEqual({ on: 2, overdue: 2 });
  });
  it("is zero for an empty day", () => {
    expect(todayCounts({ on: "2026-11-16", tasks: [] })).toEqual({ on: 0, overdue: 0 });
  });
});
