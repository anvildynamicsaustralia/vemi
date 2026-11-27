import { describe, expect, it } from "vitest";
import { PULL_AT, PULL_MAX, pulled, ready } from "./pull.js";

describe("pull to refresh", () => {
  it("does not move for a push up", () => {
    expect(pulled(-30)).toBe(0);
  });
  it("follows at half the finger, then resists, and stops", () => {
    expect(pulled(60)).toBe(30);
    expect(pulled(PULL_AT * 2 + 40)).toBeGreaterThan(PULL_AT);
    expect(pulled(2000)).toBe(PULL_MAX);
  });
  it("is ready once the mark is reached", () => {
    expect(ready(PULL_AT * 2 - 2)).toBe(false);
    expect(ready(PULL_AT * 2)).toBe(true);
  });
});
