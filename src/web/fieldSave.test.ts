import { describe, expect, it } from "vitest";
import { answered, shownValue } from "./fieldSave.js";

describe("a field's save on its way", () => {
  const saving = { text: "Glaze the pots", from: "Glaze", after: null };

  it("shows what was typed until the answer comes back", () => {
    expect(shownValue("Glaze", saving)).toBe("Glaze the pots");
    expect(answered("Glaze", saving, false)).toBe(false);
  });

  it("gives way once the value moves, in whatever form the Worker stored it", () => {
    expect(answered("Glaze the pots", saving, false)).toBe(true);
    expect(answered("glaze the pots", saving, false)).toBe(true);
  });

  it("shows the value when nothing is on its way", () => {
    expect(shownValue("Glaze", null)).toBe("Glaze");
    expect(answered("Glaze", null, true)).toBe(false);
  });

  it("holds a body cleared to nothing until the Worker says so", () => {
    const clearing = { text: "", from: "Some words\n", after: null };
    expect(shownValue("Some words\n", clearing)).toBe("");
    expect(answered(null, clearing, false)).toBe(true);
  });

  it("goes on holding a write still on this device, whatever the screen reads meanwhile", () => {
    expect(answered("Glaze", saving, true)).toBe(false);
  });

  it("holds a write that has left until a read begun after it comes back", () => {
    expect(answered("Glaze", { ...saving, after: 7 }, false)).toBe(false);
  });

  it("gives way to the old value when the read after the write still has it", () => {
    // Refused when the outbox sent it, or undone before the first read came back: the
    // Worker holds what the save replaced, and so must the field.
    expect(answered("Glaze", { ...saving, after: 7 }, true)).toBe(true);
  });
});
