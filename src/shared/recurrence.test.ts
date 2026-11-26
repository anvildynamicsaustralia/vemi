import { describe, expect, it } from "vitest";
import { nextDue } from "./recurrence.js";
import { parseRepeat } from "./repeat.js";

function due(text: string, from: string, today: string): string {
  const repeat = parseRepeat(text);
  if (repeat === null) throw new Error(`bad repeat ${text}`);
  return nextDue(repeat, from, today);
}

describe("nextDue day", () => {
  it("is the day after from when today is not later", () => {
    expect(due("day", "2026-03-10", "2026-03-10")).toBe("2026-03-11");
    expect(due("day", "2026-03-10", "2026-03-01")).toBe("2026-03-11");
  });
  it("is the day after today when from is behind", () => {
    expect(due("day", "2026-03-10", "2026-03-20")).toBe("2026-03-21");
  });
  it("crosses a month end, a year end and a leap day", () => {
    expect(due("day", "2026-01-31", "2026-01-31")).toBe("2026-02-01");
    expect(due("day", "2025-12-31", "2025-12-31")).toBe("2026-01-01");
    expect(due("day", "2028-02-28", "2028-02-28")).toBe("2028-02-29");
    expect(due("day", "2028-02-29", "2028-02-29")).toBe("2028-03-01");
    expect(due("day", "2026-02-28", "2026-02-28")).toBe("2026-03-01");
  });
  it("steps across the Sydney daylight-saving days by date alone", () => {
    expect(due("day", "2025-10-04", "2025-10-04")).toBe("2025-10-05");
    expect(due("day", "2025-10-05", "2025-10-05")).toBe("2025-10-06");
    expect(due("day", "2026-04-04", "2026-04-04")).toBe("2026-04-05");
    expect(due("day", "2026-04-05", "2026-04-05")).toBe("2026-04-06");
  });
});

describe("nextDue weekday", () => {
  it("skips the weekend", () => {
    expect(due("weekday", "2026-03-06", "2026-03-06")).toBe("2026-03-09"); // Fri to Mon
    expect(due("weekday", "2026-03-07", "2026-03-07")).toBe("2026-03-09"); // Sat
    expect(due("weekday", "2026-03-08", "2026-03-08")).toBe("2026-03-09"); // Sun
    expect(due("weekday", "2026-03-09", "2026-03-09")).toBe("2026-03-10");
  });
  it("is strictly after today", () => {
    expect(due("weekday", "2026-03-02", "2026-03-11")).toBe("2026-03-12");
  });
  it("crosses a year end and the Sydney days", () => {
    expect(due("weekday", "2025-12-31", "2025-12-31")).toBe("2026-01-01"); // Wed to Thu
    expect(due("weekday", "2025-10-03", "2025-10-03")).toBe("2025-10-06"); // Fri to Mon over the 5th
    expect(due("weekday", "2026-04-03", "2026-04-03")).toBe("2026-04-06");
  });
});

describe("nextDue week", () => {
  it("lands on the named weekday, never on the day itself", () => {
    expect(due("week:1", "2026-03-09", "2026-03-09")).toBe("2026-03-16"); // Monday to next Monday
    expect(due("week:6", "2026-03-09", "2026-03-09")).toBe("2026-03-14"); // Monday to Saturday
    expect(due("week:7", "2026-03-08", "2026-03-08")).toBe("2026-03-15"); // Sunday to Sunday
  });
  it("is strictly after today when today is later", () => {
    expect(due("week:6", "2026-03-01", "2026-03-14")).toBe("2026-03-21");
    expect(due("week:6", "2026-03-01", "2026-03-13")).toBe("2026-03-14");
  });
  it("crosses a year end, a leap day and the Sydney days", () => {
    expect(due("week:4", "2025-12-31", "2025-12-31")).toBe("2026-01-01");
    expect(due("week:2", "2028-02-27", "2028-02-27")).toBe("2028-02-29");
    expect(due("week:7", "2025-10-05", "2025-10-05")).toBe("2025-10-12");
    expect(due("week:6", "2025-10-01", "2025-10-01")).toBe("2025-10-04");
    expect(due("week:7", "2026-04-01", "2026-04-01")).toBe("2026-04-05");
  });
});

describe("nextDue month", () => {
  it("keeps the day of the month", () => {
    expect(due("month", "2026-03-10", "2026-03-10")).toBe("2026-04-10");
  });
  it("takes the last day when the month is shorter", () => {
    expect(due("month", "2026-01-31", "2026-01-31")).toBe("2026-02-28");
    expect(due("month", "2028-01-31", "2028-01-31")).toBe("2028-02-29");
    expect(due("month", "2026-03-31", "2026-03-31")).toBe("2026-04-30");
  });
  it("holds the original day across a short month", () => {
    expect(due("month", "2026-01-31", "2026-02-28")).toBe("2026-03-31");
  });
  it("crosses a year end", () => {
    expect(due("month", "2025-12-15", "2025-12-15")).toBe("2026-01-15");
    expect(due("month", "2025-12-31", "2025-12-31")).toBe("2026-01-31");
  });
  it("is strictly after today when today is later", () => {
    expect(due("month", "2026-01-10", "2026-04-10")).toBe("2026-05-10");
    expect(due("month", "2026-01-10", "2026-04-09")).toBe("2026-04-10");
  });
  it("handles a leap day", () => {
    expect(due("month", "2028-02-29", "2028-02-29")).toBe("2028-03-29");
    expect(due("month", "2027-02-28", "2027-02-28")).toBe("2027-03-28");
  });
  it("handles the Sydney days", () => {
    expect(due("month", "2025-09-05", "2025-09-05")).toBe("2025-10-05");
    expect(due("month", "2026-03-05", "2026-03-05")).toBe("2026-04-05");
  });
});
