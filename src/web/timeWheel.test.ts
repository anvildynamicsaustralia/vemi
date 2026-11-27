import { describe, expect, it } from "vitest";
import { fromWheel, said, toWheel } from "./timeWheel.js";

describe("the time wheels", () => {
  it("reads a 24-hour time as hour, minute and am or pm", () => {
    expect(toWheel("17:30")).toEqual({ hour: 5, minute: 30, pm: true });
    expect(toWheel("00:00")).toEqual({ hour: 12, minute: 0, pm: false });
    expect(toWheel("12:15")).toEqual({ hour: 12, minute: 15, pm: true });
  });
  it("rounds to the nearest five, carrying into the hour", () => {
    expect(toWheel("09:07")).toEqual({ hour: 9, minute: 5, pm: false });
    expect(toWheel("09:58")).toEqual({ hour: 10, minute: 0, pm: false });
    expect(toWheel("23:58")).toEqual({ hour: 12, minute: 0, pm: false });
  });
  it("starts at 9 am when there is no time", () => {
    expect(toWheel("")).toEqual({ hour: 9, minute: 0, pm: false });
  });
  it("writes back the 24-hour time, and says it", () => {
    expect(fromWheel({ hour: 12, minute: 0, pm: false })).toBe("00:00");
    expect(fromWheel({ hour: 12, minute: 5, pm: true })).toBe("12:05");
    expect(fromWheel({ hour: 7, minute: 45, pm: true })).toBe("19:45");
    expect(said({ hour: 7, minute: 5, pm: true })).toBe("7:05 pm");
  });
});
