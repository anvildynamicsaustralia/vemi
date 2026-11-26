import { describe, expect, it } from "vitest";
import { ACTION_MS, PLAIN_MS, begin, holding, leftAt, pause, resume, stayFor } from "./noticeTimer.js";

describe("the notice timer", () => {
  it("keeps the usual times", () => {
    expect(stayFor(true)).toBe(12000);
    expect(stayFor(false)).toBe(8000);
    expect([PLAIN_MS, ACTION_MS]).toEqual([8000, 12000]);
  });

  it("runs down with the clock", () => {
    const c = begin(12000, 1000);
    expect(leftAt(c, 1000)).toBe(12000);
    expect(leftAt(c, 6000)).toBe(7000);
    expect(leftAt(c, 99999)).toBe(0);
  });

  it("stands still while paused and resumes with the full remaining time", () => {
    const paused = pause(begin(12000, 0), 5000);
    expect(leftAt(paused, 5000)).toBe(7000);
    expect(leftAt(paused, 60000)).toBe(7000);
    const running = resume(paused, 60000);
    expect(leftAt(running, 60000)).toBe(7000);
    expect(leftAt(running, 62000)).toBe(5000);
  });

  it("survives several pauses and ignores doubled calls", () => {
    let c = begin(12000, 0);
    c = pause(c, 2000);
    c = pause(c, 9000);
    c = resume(c, 10000);
    c = resume(c, 11000);
    c = pause(c, 13000);
    expect(leftAt(c, 50000)).toBe(7000);
  });

  it("holds while the pointer is over it or focus is inside it", () => {
    expect(holding(false, false)).toBe(false);
    expect(holding(true, false)).toBe(true);
    expect(holding(false, true)).toBe(true);
    expect(holding(true, true)).toBe(true);
  });
});
