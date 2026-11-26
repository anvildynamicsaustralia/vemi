import { describe, expect, it } from "vitest";
import { fuzzyFilter, fuzzyScore } from "./fuzzy.js";

describe("fuzzyScore", () => {
  it("matches everything for empty or blank text", () => {
    expect(fuzzyScore("", "Anything")).not.toBeNull();
    expect(fuzzyScore("   ", "Anything")).not.toBeNull();
  });

  it("is case blind", () => {
    expect(fuzzyScore("PLAN", "plan the launch")).not.toBeNull();
  });

  it("needs every typed word to match, in any order", () => {
    expect(fuzzyScore("launch plan", "Plan the launch")).not.toBeNull();
    expect(fuzzyScore("launch budget", "Plan the launch")).toBeNull();
  });

  it("lets a word sit inside a title word", () => {
    expect(fuzzyScore("aunc", "Plan the launch")).not.toBeNull();
  });

  it("ranks start-of-word above inside", () => {
    const start = fuzzyScore("lau", "Plan the launch");
    const inside = fuzzyScore("aun", "Plan the launch");
    expect(start).not.toBeNull();
    expect(inside).not.toBeNull();
    expect(start as number).toBeGreaterThan(inside as number);
  });

  it("does not match when nothing is close", () => {
    expect(fuzzyScore("zzz", "Plan the launch")).toBeNull();
  });
});

describe("fuzzyFilter", () => {
  it("drops misses and orders best first, keeping input order on ties", () => {
    const rows = ["The lantern", "Plan launch", "Unrelated", "Launch plan"];
    expect(fuzzyFilter(rows, "lau", (r) => r)).toEqual(["Plan launch", "Launch plan"]);
  });

  it("puts a start-of-word match ahead of an inside one", () => {
    const rows = ["Relaunch", "Launch"];
    expect(fuzzyFilter(rows, "lau", (r) => r)).toEqual(["Launch", "Relaunch"]);
  });

  it("returns all rows for empty text", () => {
    expect(fuzzyFilter(["b", "a"], "", (r) => r)).toEqual(["b", "a"]);
  });
});
