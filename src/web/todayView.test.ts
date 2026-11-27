import { describe, expect, it } from "vitest";
import type { DateOnly, StateKind, Today, TodayTask, Tree, TaskWithBlocker } from "@vemi/shared";
import { laterPlan, laterPosition, moveTo, todayView } from "./todayView.js";

const ON: DateOnly = "2026-11-17";

const task = (id: string, o: Partial<TodayTask> = {}): TodayTask => ({
  id, createdAt: "", updatedAt: "", archivedAt: null, ventureId: "v", projectId: null, milestoneId: null,
  stateId: null, title: id, body: null, checklist: [], priority: null, dueOn: null, pickedOn: ON,
  position: 0, todayPosition: null, remindAt: null, repeat: null, blocker: null, tagIds: [],
  stateKind: "not_started", picked: true, overdue: false, ...o,
});

const finished = (id: string, o: Partial<TodayTask> = {}): TodayTask =>
  task(id, { stateKind: "finished" as StateKind, stateId: "fin", ...o });

const plain = (id: string, dueOn: string | null, stateId: string | null = null): TaskWithBlocker => {
  const { stateKind: _k, picked: _p, overdue: _o, ...rest } = task(id, { dueOn, pickedOn: null, stateId });
  return rest;
};

function tree(tasks: readonly TaskWithBlocker[]): Tree {
  return {
    ventures: [{
      id: "v", states: [
        { id: "todo", kind: "not_started" }, { id: "fin", kind: "finished" },
      ], stages: [], projects: [], tasks,
    }],
  } as unknown as Tree;
}

const day = (tasks: TodayTask[]): Today => ({ on: ON, tasks });

describe("todayView", () => {
  it("is empty for an empty day", () => {
    expect(todayView(day([]), tree([]), ON)).toEqual({
      done: 0, total: 0, next: null, also: [], finished: [], coming: [],
    });
  });

  it("is all done when every picked task is finished", () => {
    const v = todayView(day([finished("a"), finished("b")]), tree([]), ON);
    expect(v).toMatchObject({ done: 2, total: 2, next: null, also: [] });
    expect(v.finished.map((t) => t.id)).toEqual(["a", "b"]);
  });

  it("puts overdue first, then todayPosition", () => {
    const v = todayView(day([
      task("p2", { todayPosition: 2 }),
      task("p1", { todayPosition: 1 }),
      task("late", { picked: false, overdue: true, pickedOn: null, dueOn: "2026-11-10", todayPosition: 9 }),
    ]), tree([]), ON);
    expect(v.next?.id).toBe("late");
    expect(v.also.map((t) => t.id)).toEqual(["p1", "p2"]);
    expect(v.total).toBe(3);
  });

  it("puts a picked task with no position after positioned ones, keeping order", () => {
    const v = todayView(day([
      task("none1"), task("pos", { todayPosition: 5 }), task("none2"),
    ]), tree([]), ON);
    expect([v.next?.id, ...v.also.map((t) => t.id)]).toEqual(["pos", "none1", "none2"]);
  });

  it("counts a picked overdue task once, and an overdue unpicked one in the total", () => {
    const v = todayView(day([
      task("both", { overdue: true }),
      task("late", { picked: false, overdue: true, pickedOn: null }),
      finished("d"),
    ]), tree([]), ON);
    expect(v.total).toBe(3);
    expect(v.done).toBe(1);
  });

  it("lists coming tasks from today to 7 days ahead, unpicked, soonest first, across month end", () => {
    const on = "2026-11-27";
    const v = todayView({ on, tasks: [task("picked", { dueOn: "2026-11-29" })] }, tree([
      plain("today", "2026-11-27"),
      plain("b", "2026-12-04"),
      plain("a", "2026-11-28"),
      plain("far", "2026-12-05"),
      plain("picked", "2026-11-29"),
      plain("undated", null),
      plain("done", "2026-11-30", "fin"),
    ]), on);
    // Due today and not picked is still today's business: it is listed first, with Do today.
    expect(v.coming.map((c) => c.id)).toEqual(["today", "a", "b"]);
  });
});

describe("laterPosition", () => {
  it("is one more than the highest todayPosition", () => {
    expect(laterPosition(day([task("a", { todayPosition: 3 }), task("b", { todayPosition: 7 }), task("c")]))).toBe(8);
  });
  it("is 1 when nothing has a position", () => {
    expect(laterPosition(day([task("a")]))).toBe(1);
    expect(laterPosition(day([]))).toBe(1);
  });
});

describe("laterPlan", () => {
  it("demotes the next task when nothing had a position", () => {
    const today = day([task("a"), task("b"), task("c")]);
    const view = todayView(today, tree([]), ON);
    expect(view.next?.id).toBe("a");
    const steps = laterPlan(today, view, "a");
    const after = day(today.tasks.map((t) => {
      const s = steps.find((x) => x.id === t.id);
      return s === undefined ? t : { ...t, todayPosition: s.to };
    }));
    const now = todayView(after, tree([]), ON);
    expect(now.next?.id).toBe("b");
    expect(now.also.map((t) => t.id)).toEqual(["c", "a"]);
  });
  it("keeps positioned tasks where they are and records the old place", () => {
    const today = day([task("a", { todayPosition: 1 }), task("b", { todayPosition: 2 })]);
    const steps = laterPlan(today, todayView(today, tree([]), ON), "a");
    expect(steps).toEqual([{ id: "a", from: 1, to: 3 }]);
  });
});

describe("moveTo", () => {
  it("today picks for today", () => {
    expect(moveTo("today", ON)).toEqual({ pickedOn: ON });
  });
  it("tomorrow sets the due date and clears the pick, across month end", () => {
    expect(moveTo("tomorrow", ON)).toEqual({ dueOn: "2026-11-18", pickedOn: null });
    expect(moveTo("tomorrow", "2026-11-30")).toEqual({ dueOn: "2026-12-01", pickedOn: null });
  });
  it("next week is the next Monday", () => {
    // 2026-11-17 is a Tuesday.
    expect(moveTo("nextWeek", ON)).toEqual({ dueOn: "2026-11-23", pickedOn: null });
    // A Monday goes a full week on.
    expect(moveTo("nextWeek", "2026-11-23")).toEqual({ dueOn: "2026-11-30", pickedOn: null });
    // A Sunday goes to the very next day.
    expect(moveTo("nextWeek", "2026-11-22")).toEqual({ dueOn: "2026-11-23", pickedOn: null });
  });
});

