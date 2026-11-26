import { describe, expect, it } from "vitest";
import type { TodayTask } from "@vemi/shared";
import { metaParts, reminderWord } from "./todayMeta.js";

const task = (over: Partial<TodayTask>): TodayTask => ({ overdue: false, dueOn: null, repeat: null, remindAt: null, ...over }) as TodayTask;

describe("reminderWord", () => {
  it("reads a clock time", () => {
    expect(reminderWord("2026-11-17T09:00", "2026-11-17")).toBe("9:00 am");
    expect(reminderWord("2026-11-17T12:30", "2026-11-17")).toBe("12:30 pm");
    expect(reminderWord("2026-11-17T00:05", "2026-11-17")).toBe("12:05 am");
    expect(reminderWord("2026-11-17T17:00", "2026-11-17")).toBe("5:00 pm");
  });
  it("names the day when it is not today, and says nothing for nothing", () => {
    expect(reminderWord("2026-11-18T09:00", "2026-11-17")).toContain("9:00 am");
    expect(reminderWord("2026-11-18T09:00", "2026-11-17")).not.toBe("9:00 am");
    expect(reminderWord(null, "2026-11-17")).toBeNull();
    expect(reminderWord("soon", "2026-11-17")).toBeNull();
  });
});

describe("metaParts", () => {
  it("is empty for a task with nothing to say", () => {
    expect(metaParts(task({}), "", "2026-11-17")).toEqual([]);
  });
  it("keeps the mock's order: overdue, where, repeat, reminder", () => {
    const parts = metaParts(task({ overdue: true, dueOn: "2026-11-14", repeat: "day", remindAt: "2026-11-17T09:00" }), "Shed", "2026-11-17");
    expect(parts.map((p) => p.kind)).toEqual(["overdue", "where", "repeat", "reminder"]);
    expect(parts[0]?.text.startsWith("Overdue")).toBe(true);
    expect(parts[2]?.text).toBe("Every day");
  });
});
