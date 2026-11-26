import { describe, expect, it } from "vitest";
import { greeting, longDate } from "./greeting.js";

describe("greeting", () => {
  it("says morning before noon", () => {
    expect(greeting(0)).toBe("Good morning");
    expect(greeting(11)).toBe("Good morning");
  });
  it("says afternoon from noon to before six", () => {
    expect(greeting(12)).toBe("Good afternoon");
    expect(greeting(17)).toBe("Good afternoon");
  });
  it("says evening from six", () => {
    expect(greeting(18)).toBe("Good evening");
    expect(greeting(23)).toBe("Good evening");
  });
});

describe("longDate", () => {
  it("writes the weekday, day, month and year of the date given", () => {
    expect(longDate("2026-11-16")).toBe("Monday 16 November 2026");
  });
  it("does not move the date with the device's zone", () => {
    expect(longDate("2026-01-01")).toBe("Thursday 1 January 2026");
  });
});
