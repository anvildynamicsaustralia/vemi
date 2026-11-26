import { describe, expect, it } from "vitest";
import { badgeSpoken, badgeText } from "./needsCount.js";

describe("the needs-you badge", () => {
  it("shows nothing for none and the number up to nine", () => {
    expect(badgeText(0)).toBeNull();
    expect(badgeText(1)).toBe("1");
    expect(badgeText(9)).toBe("9");
  });
  it("caps at 9+", () => {
    expect(badgeText(10)).toBe("9+");
    expect(badgeText(250)).toBe("9+");
  });
  it("says the real number aloud, never the cap", () => {
    expect(badgeSpoken(1)).toBe("1 needs you");
    expect(badgeSpoken(12)).toBe("12 need you");
  });
});
