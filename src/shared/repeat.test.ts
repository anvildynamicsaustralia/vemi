import { describe, expect, it } from "vitest";
import { parseRepeat, repeatWord, weeklyOn } from "./repeat.js";

describe("parseRepeat", () => {
  it("reads the four shapes", () => {
    expect(parseRepeat("day")).toEqual({ kind: "day" });
    expect(parseRepeat("weekday")).toEqual({ kind: "weekday" });
    expect(parseRepeat("month")).toEqual({ kind: "month" });
    expect(parseRepeat("week:1")).toEqual({ kind: "week", day: 1 });
    expect(parseRepeat("week:7")).toEqual({ kind: "week", day: 7 });
  });

  it("refuses anything outside the grammar", () => {
    for (const bad of ["", "daily", "Day", "week", "week:0", "week:8", "week:1.5", "week:01", "week:-1", " day", "week:1 ", "year", 5, null, undefined]) {
      expect(parseRepeat(bad), String(bad)).toBeNull();
    }
  });
});

describe("repeatWord", () => {
  it("says each repeat in words", () => {
    expect(repeatWord("day")).toBe("Every day");
    expect(repeatWord("weekday")).toBe("Every weekday");
    expect(repeatWord("month")).toBe("Every month");
    expect(repeatWord("week:1")).toBe("Every Monday");
    expect(repeatWord("week:4")).toBe("Every Thursday");
    expect(repeatWord("week:7")).toBe("Every Sunday");
  });

  it("gives null for no repeat or a bad one", () => {
    expect(repeatWord(null)).toBeNull();
    expect(repeatWord("fortnight")).toBeNull();
  });
});

describe("weeklyOn", () => {
  it("names the date's own weekday, Monday as 1", () => {
    expect(weeklyOn("2026-11-16")).toBe("week:1");
    expect(weeklyOn("2026-11-17")).toBe("week:2");
    expect(weeklyOn("2026-11-21")).toBe("week:6");
    expect(weeklyOn("2026-11-22")).toBe("week:7");
  });
});
