import { describe, expect, it } from "vitest";
import { drifted, holds, HOLD_SLOP } from "./hold.js";

describe("touch and hold", () => {
  it("holds for a finger or a pen on the first button, never for a mouse", () => {
    expect(holds("touch", 0)).toBe(true);
    expect(holds("pen", 0)).toBe(true);
    expect(holds("mouse", 0)).toBe(false);
    expect(holds("touch", 2)).toBe(false);
  });

  it("lets the finger drift a little and calls anything further a drag", () => {
    expect(drifted({ x: 10, y: 10 }, { x: 10 + HOLD_SLOP, y: 10 })).toBe(false);
    expect(drifted({ x: 10, y: 10 }, { x: 10 + HOLD_SLOP, y: 11 })).toBe(true);
  });
});
