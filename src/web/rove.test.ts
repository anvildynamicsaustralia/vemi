import { describe, expect, it } from "vitest";
import { roveTo, tabTo, type Press } from "./rove.js";

/** A key pressed alone, or held with the named modifiers. */
const key = (name: string, held: Partial<Omit<Press, "key">> = {}): Press =>
  ({ key: name, altKey: false, ctrlKey: false, metaKey: false, ...held });

describe("roveTo", () => {
  it("steps down and up, and goes round at the ends", () => {
    expect(roveTo(key("ArrowDown"), 0, 3)).toBe(1);
    expect(roveTo(key("ArrowDown"), 2, 3)).toBe(0);
    expect(roveTo(key("ArrowUp"), 1, 3)).toBe(0);
    expect(roveTo(key("ArrowUp"), 0, 3)).toBe(2);
  });

  it("jumps to the ends with Home and End", () => {
    expect(roveTo(key("Home"), 2, 4)).toBe(0);
    expect(roveTo(key("End"), 0, 4)).toBe(3);
  });

  it("starts from an end when nothing in the list has the focus yet", () => {
    expect(roveTo(key("ArrowDown"), -1, 3)).toBe(0);
    expect(roveTo(key("ArrowUp"), -1, 3)).toBe(2);
  });

  it("leaves every other key, and an empty list, alone", () => {
    expect(roveTo(key("ArrowLeft"), 0, 3)).toBeNull();
    expect(roveTo(key("Tab"), 0, 3)).toBeNull();
    expect(roveTo(key("ArrowDown"), -1, 0)).toBeNull();
  });

  it("leaves a key held with Alt, Ctrl or Cmd to the browser", () => {
    expect(roveTo(key("ArrowDown", { altKey: true }), 0, 3)).toBeNull();
    expect(roveTo(key("End", { ctrlKey: true }), 0, 3)).toBeNull();
    expect(roveTo(key("ArrowUp", { metaKey: true }), 1, 3)).toBeNull();
  });
});

describe("tabTo", () => {
  it("steps right and left through a row of tabs and goes round at the ends", () => {
    expect(tabTo(key("ArrowRight"), 0, 3)).toBe(1);
    expect(tabTo(key("ArrowRight"), 2, 3)).toBe(0);
    expect(tabTo(key("ArrowLeft"), 0, 3)).toBe(2);
  });

  it("jumps to the ends, and leaves other keys and chorded arrows alone", () => {
    expect(tabTo(key("Home"), 2, 4)).toBe(0);
    expect(tabTo(key("End"), 0, 4)).toBe(3);
    expect(tabTo(key("ArrowDown"), 0, 3)).toBeNull();
    expect(tabTo(key("ArrowRight", { altKey: true }), 0, 3)).toBeNull();
    expect(tabTo(key("ArrowRight"), 0, 0)).toBeNull();
  });
});
