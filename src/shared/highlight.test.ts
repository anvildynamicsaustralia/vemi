import { describe, expect, it } from "vitest";
import { highlight } from "./highlight.js";

describe("highlight", () => {
  it("returns one plain part for empty text", () => {
    expect(highlight("Plan launch", "  ")).toEqual([{ text: "Plan launch", match: false }]);
  });

  it("returns nothing for an empty source", () => {
    expect(highlight("", "a")).toEqual([]);
  });

  it("marks matches case blind and keeps the source casing", () => {
    expect(highlight("Plan Launch", "launch")).toEqual([
      { text: "Plan ", match: false },
      { text: "Launch", match: true },
    ]);
  });

  it("marks every typed word wherever it sits", () => {
    expect(highlight("Plan the launch", "lau pl")).toEqual([
      { text: "Pl", match: true },
      { text: "an the ", match: false },
      { text: "lau", match: true },
      { text: "nch", match: false },
    ]);
  });

  it("merges overlapping and touching matches", () => {
    expect(highlight("abcdef", "abc cde")).toEqual([
      { text: "abcde", match: true },
      { text: "f", match: false },
    ]);
  });

  it("marks repeated occurrences", () => {
    expect(highlight("aXa", "a")).toEqual([
      { text: "a", match: true },
      { text: "X", match: false },
      { text: "a", match: true },
    ]);
  });

  it("treats regex characters as plain text", () => {
    expect(highlight("cost (a+b) .*", "(a+b)")).toEqual([
      { text: "cost ", match: false },
      { text: "(a+b)", match: true },
      { text: " .*", match: false },
    ]);
    expect(highlight("anything", ".*")).toEqual([{ text: "anything", match: false }]);
  });

  it("joins back to the source", () => {
    const parts = highlight("Fix the Ünïcode bug", "ünï bug");
    expect(parts.map((p) => p.text).join("")).toBe("Fix the Ünïcode bug");
    expect(parts.some((p) => p.match)).toBe(true);
  });
});
