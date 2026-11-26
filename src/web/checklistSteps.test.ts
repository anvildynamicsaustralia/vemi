import { describe, expect, it } from "vitest";
import { keyed, movedTo, stored, type KeyedStep } from "./checklistSteps.js";

const counter = () => {
  let n = 0;
  return () => `new${++n}`;
};

describe("a step's id", () => {
  it("is new for each step the first time the list is seen", () => {
    expect(keyed([], [{ text: "Cut", done: false }, { text: "Mix", done: true }], counter())).toEqual([
      { id: "new1", text: "Cut", done: false },
      { id: "new2", text: "Mix", done: true },
    ]);
  });

  it("stays with its step when the list comes back ticked, reordered or one shorter", () => {
    const held: KeyedStep[] = [{ id: "a", text: "Cut", done: false }, { id: "b", text: "Mix", done: false }, { id: "c", text: "Ship", done: false }];
    expect(keyed(held, [{ text: "Ship", done: false }, { text: "Cut", done: true }], counter()).map((s) => s.id)).toEqual(["c", "a"]);
  });

  it("goes in order between steps of the same text, and a renamed step is new", () => {
    const held: KeyedStep[] = [{ id: "a", text: "Call", done: false }, { id: "b", text: "Call", done: true }];
    expect(keyed(held, [{ text: "Call", done: false }, { text: "Call back", done: true }], counter()).map((s) => s.id)).toEqual(["a", "new1"]);
  });

  it("is never stored", () => {
    expect(stored([{ id: "a", text: "Cut", done: true }])).toEqual([{ text: "Cut", done: true }]);
  });
});

describe("moving a step", () => {
  const steps: KeyedStep[] = ["a", "b", "c"].map((id) => ({ id, text: id, done: false }));

  it("puts it at an index of the list without it, the way the grip counts", () => {
    expect(movedTo(steps, "a", 2).map((s) => s.id)).toEqual(["b", "c", "a"]);
    expect(movedTo(steps, "c", 0).map((s) => s.id)).toEqual(["c", "a", "b"]);
    expect(movedTo(steps, "b", 9).map((s) => s.id)).toEqual(["a", "c", "b"]);
  });

  it("leaves the list as it was for a step it does not hold", () => {
    expect(movedTo(steps, "z", 0)).toEqual(steps);
  });
});
