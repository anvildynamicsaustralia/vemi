import { describe, expect, it } from "vitest";
import { riskMark } from "./riskMark.js";

describe("riskMark", () => {
  it("says Blocked when both hold, because Blocked is the stronger word", () => {
    expect(riskMark(true, true)).toBe("blocked");
  });
  it("says Blocked when only blocked holds", () => {
    expect(riskMark(true, false)).toBe("blocked");
  });
  it("says at risk when only at risk holds", () => {
    expect(riskMark(false, true)).toBe("at-risk");
  });
  it("says nothing when neither holds", () => {
    expect(riskMark(false, false)).toBeNull();
  });
});
