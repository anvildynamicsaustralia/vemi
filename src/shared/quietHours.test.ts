import { describe, expect, it } from "vitest";
import { clockMinutes, inQuiet, isClock, quietEnd } from "./quietHours.js";

const at = (h: number, m = 0) => h * 60 + m;

describe("isClock and clockMinutes", () => {
  it("takes HH:MM only", () => {
    expect(isClock("07:00")).toBe(true);
    expect(isClock("23:59")).toBe(true);
    for (const bad of ["7:00", "24:00", "07:60", "07:00:00", "", null, 700]) expect(isClock(bad)).toBe(false);
    expect(clockMinutes("06:30")).toBe(390);
    expect(clockMinutes("nope")).toBeNull();
    expect(clockMinutes(null)).toBeNull();
  });
});

describe("inQuiet", () => {
  it("spans midnight", () => {
    expect(inQuiet(at(21), "21:00", "07:00")).toBe(true);
    expect(inQuiet(at(23, 59), "21:00", "07:00")).toBe(true);
    expect(inQuiet(at(0), "21:00", "07:00")).toBe(true);
    expect(inQuiet(at(6, 59), "21:00", "07:00")).toBe(true);
    expect(inQuiet(at(7), "21:00", "07:00")).toBe(false);
    expect(inQuiet(at(12), "21:00", "07:00")).toBe(false);
    expect(inQuiet(at(20, 59), "21:00", "07:00")).toBe(false);
  });
  it("handles a window inside one day", () => {
    expect(inQuiet(at(13), "13:00", "14:00")).toBe(true);
    expect(inQuiet(at(14), "13:00", "14:00")).toBe(false);
    expect(inQuiet(at(12, 59), "13:00", "14:00")).toBe(false);
  });
  it("is never quiet with no window", () => {
    expect(inQuiet(at(3), null, null)).toBe(false);
    expect(inQuiet(at(3), "21:00", null)).toBe(false);
    expect(inQuiet(at(3), null, "07:00")).toBe(false);
    expect(inQuiet(at(3), "07:00", "07:00")).toBe(false);
  });
});

describe("quietEnd", () => {
  it("is the minute the window ends", () => {
    expect(quietEnd("21:00", "07:00")).toBe(420);
    expect(quietEnd("13:00", "14:30")).toBe(870);
  });
  it("is null with no window", () => {
    expect(quietEnd(null, "07:00")).toBeNull();
    expect(quietEnd("21:00", null)).toBeNull();
    expect(quietEnd("07:00", "07:00")).toBeNull();
  });
});
