import { describe, expect, it } from "vitest";
import { axisOf, followed, LEAD_MIN, releaseOf, TRAIL_OPEN } from "./swipe.js";

describe("axisOf", () => {
  it("waits until the finger has gone far enough to say", () => {
    expect(axisOf(4, 3)).toBeNull();
  });
  it("reads sideways first as a swipe and up or down first as a scroll", () => {
    expect(axisOf(30, 5)).toBe("swipe");
    expect(axisOf(-30, 8)).toBe("swipe");
    expect(axisOf(8, 30)).toBe("scroll");
    expect(axisOf(20, 20)).toBe("scroll");
  });
});

describe("followed", () => {
  it("follows right only when there is a leading action", () => {
    expect(followed(80, true, 120, 340)).toBe(80);
    expect(followed(80, false, 120, 340)).toBe(0);
  });
  it("follows left to the buttons, then resists", () => {
    expect(followed(-100, true, 120, 340)).toBe(-100);
    expect(followed(-220, true, 120, 340)).toBeCloseTo(-150);
    expect(followed(-50, true, 0, 340)).toBe(0);
  });
});

describe("releaseOf", () => {
  it("runs the leading action past a third of the row", () => {
    expect(releaseOf(130, 340, true, 120)).toBe("lead");
    expect(releaseOf(LEAD_MIN - 1, 200, true, 120)).toBe("close");
  });
  it("opens the trailing buttons past a short pull, and closes them on a push back", () => {
    expect(releaseOf(-TRAIL_OPEN, 340, true, 120)).toBe("open");
    expect(releaseOf(-20, 340, true, 120)).toBe("close");
    expect(releaseOf(-10, 340, true, 120, true)).toBe("open");
    expect(releaseOf(40, 340, true, 120, true)).toBe("close");
  });
});
