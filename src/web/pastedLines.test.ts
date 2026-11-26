import { describe, expect, it } from "vitest";
import { pastedLines } from "./pastedLines.js";

describe("a paste into an add line", () => {
  it("is one item a line when it has two lines or more, blank lines left out", () => {
    expect(pastedLines("Call Tommy\n\n  Order posts  \r\nGlaze")).toEqual(["Call Tommy", "Order posts", "Glaze"]);
  });

  it("leaves a list's own marks behind", () => {
    expect(pastedLines("- [ ] Call Tommy\n* Order posts\n1. Glaze\n2) Fire\n- [x] Pack\n• Ship")).toEqual(
      ["Call Tommy", "Order posts", "Glaze", "Fire", "Pack", "Ship"],
    );
  });

  it("is an ordinary paste when it is one line, or one line with blanks round it", () => {
    expect(pastedLines("Call Tommy")).toBeNull();
    expect(pastedLines("\nCall Tommy\n\n")).toBeNull();
    expect(pastedLines("")).toBeNull();
  });

  it("keeps a word that only looks like a mark", () => {
    expect(pastedLines("-30 degrees\n2026 plan")).toEqual(["-30 degrees", "2026 plan"]);
  });
});
