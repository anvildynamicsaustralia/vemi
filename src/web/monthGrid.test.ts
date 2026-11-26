import { describe, expect, it } from "vitest";
import { addDays, addMonths, dayStep, monthGrid, monthTitle, monthOf, shiftMonth, weekEnd } from "./monthGrid.js";
import type { Press } from "./rove.js";

/** A key pressed alone, or held with the named modifiers. */
const key = (name: string, held: Partial<Omit<Press, "key">> = {}): Press =>
  ({ key: name, altKey: false, ctrlKey: false, metaKey: false, ...held });

describe("monthGrid", () => {
  it("lays a month out in whole weeks that start on a Monday", () => {
    // September 2026 starts on a Tuesday and ends on a Wednesday.
    const weeks = monthGrid(2026, 9);
    expect(weeks).toHaveLength(5);
    for (const week of weeks) expect(week).toHaveLength(7);
    expect(weeks[0]?.map((c) => c.date)).toEqual([
      "2026-08-31", "2026-09-01", "2026-09-02", "2026-09-03", "2026-09-04", "2026-09-05", "2026-09-06",
    ]);
    expect(weeks[4]?.[6]?.date).toBe("2026-10-04");
  });

  it("marks the days that belong to the months either side", () => {
    const flat = monthGrid(2026, 9).flat();
    expect(flat.filter((c) => c.inMonth)).toHaveLength(30);
    expect(flat[0]).toEqual({ date: "2026-08-31", day: 31, inMonth: false });
    expect(flat.find((c) => c.date === "2026-09-18")).toEqual({ date: "2026-09-18", day: 18, inMonth: true });
  });

  it("needs six weeks when a long month starts late in the week", () => {
    // August 2026 starts on a Saturday.
    expect(monthGrid(2026, 8)).toHaveLength(6);
  });

  it("needs only four when February starts on a Monday in a common year", () => {
    const weeks = monthGrid(2027, 2);
    expect(weeks).toHaveLength(4);
    expect(weeks.flat().every((c) => c.inMonth)).toBe(true);
  });

  it("gives a leap February its 29th", () => {
    expect(monthGrid(2028, 2).flat().some((c) => c.date === "2028-02-29" && c.inMonth)).toBe(true);
    expect(monthGrid(2027, 2).flat().some((c) => c.date === "2027-02-29")).toBe(false);
  });

  it("never names a day twice, even across the week a clock change falls in", () => {
    // Local-time arithmetic repeats or skips a day here. These are dates, not moments.
    for (const [y, m] of [[2026, 3], [2026, 4], [2026, 10], [2026, 11]] as const) {
      const dates = monthGrid(y, m).flat().map((c) => c.date);
      expect(new Set(dates).size, `${y}-${m}`).toBe(dates.length);
    }
  });
});

describe("shiftMonth", () => {
  it("steps forward and back across the year", () => {
    expect(shiftMonth({ year: 2026, month: 12 }, 1)).toEqual({ year: 2027, month: 1 });
    expect(shiftMonth({ year: 2026, month: 1 }, -1)).toEqual({ year: 2025, month: 12 });
    expect(shiftMonth({ year: 2026, month: 9 }, 5)).toEqual({ year: 2027, month: 2 });
  });
});

describe("addDays", () => {
  it("adds across a month, a year and a leap day", () => {
    expect(addDays("2026-09-18", 7)).toBe("2026-09-25");
    expect(addDays("2026-09-18", 30)).toBe("2026-10-18");
    expect(addDays("2026-12-30", 7)).toBe("2027-01-06");
    expect(addDays("2028-02-28", 1)).toBe("2028-02-29");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
  });
});

describe("monthOf and monthTitle", () => {
  it("reads the month a date sits in, and says it in words", () => {
    expect(monthOf("2026-09-18")).toEqual({ year: 2026, month: 9 });
    expect(monthTitle({ year: 2026, month: 9 })).toBe("September 2026");
  });

  it("answers null for something that is not a date", () => {
    expect(monthOf("soon")).toBeNull();
  });
});

describe("weekEnd", () => {
  it("is the Sunday that ends the week, Monday first", () => {
    expect(weekEnd("2026-09-18")).toBe("2026-09-20"); // a Friday
    expect(weekEnd("2026-09-14")).toBe("2026-09-20"); // a Monday
    expect(weekEnd("2026-09-20")).toBe("2026-09-20"); // already Sunday
    expect(weekEnd("2026-12-30")).toBe("2027-01-03"); // across the year
  });
});

describe("addMonths", () => {
  it("keeps the day of the month, and crosses a year", () => {
    expect(addMonths("2026-09-14", 1)).toBe("2026-10-14");
    expect(addMonths("2026-12-14", 1)).toBe("2027-01-14");
    expect(addMonths("2026-01-14", -1)).toBe("2025-12-14");
  });

  it("lands on the last day of a shorter month rather than spilling into the next", () => {
    expect(addMonths("2026-01-31", 1)).toBe("2026-02-28");
    expect(addMonths("2028-03-31", -1)).toBe("2028-02-29");
  });
});

describe("dayStep", () => {
  it("moves a day across and a week up or down, over a month's edge", () => {
    expect(dayStep("2026-09-30", key("ArrowRight"))).toBe("2026-10-01");
    expect(dayStep("2026-09-01", key("ArrowLeft"))).toBe("2026-08-31");
    expect(dayStep("2026-09-03", key("ArrowUp"))).toBe("2026-08-27");
    expect(dayStep("2026-09-28", key("ArrowDown"))).toBe("2026-10-05");
  });

  it("moves a month with Page Up and Page Down", () => {
    expect(dayStep("2026-09-14", key("PageDown"))).toBe("2026-10-14");
    expect(dayStep("2026-03-31", key("PageUp"))).toBe("2026-02-28");
  });

  it("leaves every other key alone", () => {
    expect(dayStep("2026-09-14", key("Enter"))).toBeNull();
    expect(dayStep("2026-09-14", key("Tab"))).toBeNull();
  });

  it("leaves Back, Forward and the tab keys to the browser", () => {
    expect(dayStep("2026-09-14", key("ArrowLeft", { altKey: true }))).toBeNull();
    expect(dayStep("2026-09-14", key("ArrowRight", { altKey: true }))).toBeNull();
    expect(dayStep("2026-09-14", key("PageDown", { ctrlKey: true }))).toBeNull();
    expect(dayStep("2026-09-14", key("ArrowLeft", { metaKey: true }))).toBeNull();
  });
});
