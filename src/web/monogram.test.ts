import { describe, expect, it } from "vitest";
import { initials, mapLetters, monograms } from "./monogram.js";

describe("monograms", () => {
  it("draws the handoff's three exactly", () => {
    const m = monograms([
      { id: "bds", name: "Black Dingo Studios" },
      { id: "bdn", name: "Black Dingo Network" },
      { id: "nd", name: "Nexus Dynamics" },
    ]);
    expect([m.get("bds"), m.get("bdn"), m.get("nd")]).toEqual(["BD", "BN", "ND"]);
  });

  it("takes two letters from a one-word name, and a mark from none", () => {
    expect(initials("Vemi")).toBe("VE");
    expect(initials("  ")).toBe("·");
    expect(initials("black-dingo")).toBe("BD");
  });

  it("keeps the earlier venture's letters when two collide and the later has no way aside", () => {
    const m = monograms([{ id: "a", name: "Big Deal" }, { id: "b", name: "Blue Door" }]);
    expect([m.get("a"), m.get("b")]).toEqual(["BD", "BD"]);
  });
});

describe("mapLetters", () => {
  const studio = { id: "x", name: "Big Deal Studio" };
  const deal = { id: "y", name: "Big Deal" };

  it("letters in the map's order, by position, not the order it is handed", () => {
    for (const given of [[{ ...studio, position: 1 }, { ...deal, position: 0 }], [{ ...deal, position: 0 }, { ...studio, position: 1 }]]) {
      const m = mapLetters(given);
      expect([m.get("y"), m.get("x")]).toEqual(["BD", "BS"]);
    }
    const moved = mapLetters([{ ...studio, position: 0 }, { ...deal, position: 1 }]);
    expect([moved.get("x"), moved.get("y")]).toEqual(["BD", "BD"]);
  });

  it("breaks a tie of position by id", () => {
    const m = mapLetters([{ id: "z", name: "Big Deal Studio", position: 0 }, { id: "k", name: "Big Deal", position: 0 }]);
    expect([m.get("k"), m.get("z")]).toEqual(["BD", "BS"]);
    const n = mapLetters([{ id: "a", name: "Big Deal Studio", position: 0 }, { id: "k", name: "Big Deal", position: 0 }]);
    expect([n.get("a"), n.get("k")]).toEqual(["BD", "BD"]);
  });
});
