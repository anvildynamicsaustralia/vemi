import { describe, expect, it } from "vitest";
import type { Task } from "@vemi/shared";
import {
  moveChoice, nextMonday, remindChoice, repeatChoice, pressedMove, pressedRemind, pressedRepeat, undoPatch,
} from "./taskOptions.js";

const task = (over: Partial<Task> = {}): Task => ({
  id: "t", createdAt: "", updatedAt: "", archivedAt: null, ventureId: "v", projectId: null, milestoneId: null,
  stateId: null, title: "Write", body: null, checklist: [], priority: null, dueOn: null, pickedOn: null,
  position: 0, todayPosition: null, remindAt: null, repeat: null, ...over,
});
// Tuesday 17 November 2026.
const ON = "2026-11-17";

describe("nextMonday", () => {
  it("is the Monday after the date, a week on when the date is a Monday", () => {
    expect(nextMonday("2026-11-17")).toBe("2026-11-23");
    expect(nextMonday("2026-11-16")).toBe("2026-11-23");
    expect(nextMonday("2026-11-22")).toBe("2026-11-23");
    expect(nextMonday("2026-12-30")).toBe("2027-01-04");
  });
});

describe("moveChoice", () => {
  it("Today picks it for today", () => {
    expect(moveChoice("today", ON)).toEqual({ patch: { pickedOn: ON }, label: "put on today" });
  });
  it("Tomorrow dates it tomorrow and unpicks it", () => {
    expect(moveChoice("tomorrow", ON)).toEqual({ patch: { dueOn: "2026-11-18", pickedOn: null }, label: "moved to tomorrow" });
  });
  it("Next week dates it next Monday and unpicks it", () => {
    expect(moveChoice("week", ON)).toEqual({ patch: { dueOn: "2026-11-23", pickedOn: null }, label: "moved to next week" });
  });
});

describe("remindChoice", () => {
  it("Off clears the reminder", () => {
    expect(remindChoice("off", task(), ON, null)).toEqual({ patch: { remindAt: null }, label: "turned the reminder off" });
  });
  it("the three times use the task's own day: due, else picked, else today", () => {
    expect(remindChoice("9", task({ dueOn: "2026-11-20", pickedOn: ON }), ON, null)?.patch).toEqual({ remindAt: "2026-11-20T09:00" });
    expect(remindChoice("12", task({ pickedOn: "2026-11-18" }), ON, null)?.patch).toEqual({ remindAt: "2026-11-18T12:00" });
    expect(remindChoice("17", task(), ON, null)).toEqual({ patch: { remindAt: "2026-11-17T17:00" }, label: "set a reminder for 5 pm" });
  });
  it("Pick a time takes the time given, and refuses one that is not HH:MM", () => {
    expect(remindChoice("pick", task(), ON, "07:45")).toEqual({ patch: { remindAt: "2026-11-17T07:45" }, label: "set a reminder for 7:45 am" });
    expect(remindChoice("pick", task(), ON, "13:05")?.label).toBe("set a reminder for 1:05 pm");
    expect(remindChoice("pick", task(), ON, "00:10")?.label).toBe("set a reminder for 12:10 am");
    expect(remindChoice("pick", task(), ON, null)).toBeNull();
    expect(remindChoice("pick", task(), ON, "25:00")).toBeNull();
    expect(remindChoice("pick", task(), ON, "")).toBeNull();
  });
});

describe("repeatChoice", () => {
  it("Never clears, Daily and Monthly store their words", () => {
    expect(repeatChoice("never", task(), ON)).toEqual({ patch: { repeat: null }, label: "stopped repeating" });
    expect(repeatChoice("daily", task(), ON)).toEqual({ patch: { repeat: "day" }, label: "set to repeat every day" });
    expect(repeatChoice("monthly", task(), ON)).toEqual({ patch: { repeat: "month" }, label: "set to repeat every month" });
  });
  it("Weekly stores week:N for the task's own weekday", () => {
    expect(repeatChoice("weekly", task(), ON).patch).toEqual({ repeat: "week:2" });
    expect(repeatChoice("weekly", task({ pickedOn: "2026-11-22" }), ON).patch).toEqual({ repeat: "week:7" });
    expect(repeatChoice("weekly", task({ dueOn: "2026-11-23", pickedOn: ON }), ON)).toEqual({
      patch: { repeat: "week:1" }, label: "set to repeat every week",
    });
  });
});

describe("undoPatch", () => {
  it("puts back each field the patch touched, null included", () => {
    const t = task({ dueOn: "2026-11-20", pickedOn: ON, remindAt: "2026-11-20T09:00", repeat: "day" });
    expect(undoPatch(t, moveChoice("tomorrow", ON).patch)).toEqual({ dueOn: "2026-11-20", pickedOn: ON });
    expect(undoPatch(t, { remindAt: null })).toEqual({ remindAt: "2026-11-20T09:00" });
    expect(undoPatch(t, { repeat: "month" })).toEqual({ repeat: "day" });
    expect(undoPatch(task(), { pickedOn: ON })).toEqual({ pickedOn: null });
  });
});

describe("what is pressed", () => {
  it("Move to reads the task against today", () => {
    expect(pressedMove(task({ pickedOn: ON }), ON)).toBe("today");
    expect(pressedMove(task({ dueOn: "2026-11-18" }), ON)).toBe("tomorrow");
    expect(pressedMove(task({ dueOn: "2026-11-23" }), ON)).toBe("week");
    expect(pressedMove(task({ dueOn: "2026-11-23", pickedOn: ON }), ON)).toBe("today");
    expect(pressedMove(task(), ON)).toBeNull();
  });
  it("Remind me names the preset, else Pick a time, else Off", () => {
    expect(pressedRemind(task())).toBe("off");
    expect(pressedRemind(task({ remindAt: "2026-11-17T09:00" }))).toBe("9");
    expect(pressedRemind(task({ remindAt: "2026-11-17T12:00" }))).toBe("12");
    expect(pressedRemind(task({ remindAt: "2026-11-17T17:00" }))).toBe("17");
    expect(pressedRemind(task({ remindAt: "2026-11-17T07:45" }))).toBe("pick");
  });
  it("Repeat names the choice, and nothing for a weekday repeat", () => {
    expect(pressedRepeat(task())).toBe("never");
    expect(pressedRepeat(task({ repeat: "day" }))).toBe("daily");
    expect(pressedRepeat(task({ repeat: "week:3" }))).toBe("weekly");
    expect(pressedRepeat(task({ repeat: "month" }))).toBe("monthly");
    expect(pressedRepeat(task({ repeat: "weekday" }))).toBeNull();
  });
});
