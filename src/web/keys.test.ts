import { describe, expect, it } from "vitest";
import { heldByOverlay, keyAction, keyNames, ledAfter, type KeyLike } from "./keys.js";

const press = (key: string, extra: Partial<KeyLike> = {}, led = false): ReturnType<typeof keyAction> =>
  keyAction({ key, target: null, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...extra }, led);

const input = { tagName: "INPUT" } as unknown as EventTarget;

describe("the keys", () => {
  it("open the palette on Cmd K and Ctrl K, and search on the slash", () => {
    expect(press("k", { metaKey: true })).toEqual({ type: "palette" });
    expect(press("K", { ctrlKey: true })).toEqual({ type: "palette" });
    expect(press("/")).toEqual({ type: "search" });
  });

  it("walk a venture's two tabs in the pill's order", () => {
    expect(press("1")).toEqual({ type: "tab", tab: "board" });
    expect(press("2")).toEqual({ type: "tab", tab: "projects" });
    expect(press("3")).toBeNull();
  });

  it("add a task on N and close on Escape", () => {
    expect(press("n")).toEqual({ type: "compose" });
    expect(press("N")).toEqual({ type: "compose" });
    expect(press("Escape")).toEqual({ type: "close" });
    // One theme (VEMI-006 decision 2): T is no longer a key.
    expect(press("t")).toBeNull();
    expect(press("x")).toBeNull();
  });

  it("do nothing while someone is typing, except close and the keys with a modifier", () => {
    expect(press("n", { target: input })).toBeNull();
    expect(press("1", { target: input })).toBeNull();
    expect(press("/", { target: { tagName: "TEXTAREA" } as unknown as EventTarget })).toBeNull();
    expect(press("n", { target: { tagName: "DIV", isContentEditable: true } as unknown as EventTarget })).toBeNull();
    expect(press("Escape", { target: input })).toEqual({ type: "close" });
    expect(press("k", { metaKey: true, target: input })).toEqual({ type: "palette" });
  });

  it("open the shortcuts sheet on a question mark and a new project on P", () => {
    expect(press("?", { shiftKey: true })).toEqual({ type: "help" });
    expect(press("p")).toEqual({ type: "project" });
    expect(press("P", { shiftKey: true })).toEqual({ type: "project" });
    expect(press("p", { metaKey: true })).toBeNull();
    expect(press("?", { target: input, shiftKey: true })).toBeNull();
    expect(press("p", { target: input })).toBeNull();
  });

  it("go to Search on G then S", () => {
    expect(press("s", {}, true)).toEqual({ type: "go", place: "search" });
    expect(press("s")).toBeNull();
    expect(press("s", { target: input }, true)).toBeNull();
  });

  it("turn every single key off with the switch, keeping Cmd K, Esc and the undo keys", () => {
    const off = (key: string, extra: Partial<KeyLike> = {}, led = false): ReturnType<typeof keyAction> =>
      keyAction({ key, target: null, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...extra }, led, false);
    for (const key of ["/", "n", "p", "?", "g", "1", "2"]) expect(off(key)).toBeNull();
    for (const key of ["m", "a", "t", "s"]) expect(off(key, {}, true)).toBeNull();
    expect(off("k", { metaKey: true })).toEqual({ type: "palette" });
    expect(off("k", { ctrlKey: true, target: input })).toEqual({ type: "palette" });
    expect(off("Escape")).toEqual({ type: "close" });
    expect(off("z", { ctrlKey: true })).toEqual({ type: "undo" });
  });

  it("leave the browser's own shortcuts alone", () => {
    expect(press("n", { metaKey: true })).toBeNull();
    expect(press("t", { ctrlKey: true })).toBeNull();
    expect(press("1", { altKey: true })).toBeNull();
    expect(press("k", { metaKey: true, altKey: true })).toBeNull();
  });

  it("go to the map, the archive and Today on G and a letter", () => {
    expect(press("g")).toEqual({ type: "lead" });
    expect(press("G", { shiftKey: true })).toEqual({ type: "lead" });
    expect(press("m", {}, true)).toEqual({ type: "go", place: "map" });
    expect(press("h", {}, true)).toBeNull();
    expect(press("a", {}, true)).toEqual({ type: "go", place: "archive" });
    expect(press("t", {}, true)).toEqual({ type: "go", place: "today" });
    // Alone, the letters are nothing: no key hides behind another.
    expect(press("m")).toBeNull();
    expect(press("h")).toBeNull();
  });

  it("let a second key that goes nowhere do what it does alone", () => {
    expect(press("n", {}, true)).toEqual({ type: "compose" });
    expect(press("1", {}, true)).toEqual({ type: "tab", tab: "board" });
    expect(press("x", {}, true)).toBeNull();
    expect(press("g", {}, true)).toEqual({ type: "lead" });
  });

  it("go nowhere while someone is typing, even after a G", () => {
    expect(press("g", { target: input })).toBeNull();
    expect(press("m", { target: input }, true)).toBeNull();
    expect(press("m", { ctrlKey: true }, true)).toBeNull();
  });

  it("undo on Cmd Z and redo with Shift held", () => {
    expect(press("z", { ctrlKey: true })).toEqual({ type: "undo" });
    expect(press("z", { metaKey: true })).toEqual({ type: "undo" });
    expect(press("Z", { metaKey: true, shiftKey: true })).toEqual({ type: "redo" });
    expect(press("y", { ctrlKey: true })).toEqual({ type: "redo" });
  });

  it("leave undo and redo to the field while someone is typing", () => {
    const area = { tagName: "TEXTAREA" } as unknown as EventTarget;
    const editable = { tagName: "DIV", isContentEditable: true } as unknown as EventTarget;
    for (const target of [input, area, editable]) {
      expect(press("z", { ctrlKey: true, target })).toBeNull();
      expect(press("z", { metaKey: true, target })).toBeNull();
      expect(press("Z", { metaKey: true, shiftKey: true, target })).toBeNull();
      expect(press("y", { ctrlKey: true, target })).toBeNull();
    }
    expect(press("z", { target: input })).toBeNull();
    expect(press("z")).toBeNull();
  });

  it("still search on Cmd K inside a field, which no field uses", () => {
    expect(press("k", { ctrlKey: true, target: input })).toEqual({ type: "palette" });
  });

  it("keep the G waiting through a lone Shift, so G then Shift M still goes", () => {
    let ledAt = 0;
    let now = 1000;
    const step = (key: string, extra: Partial<KeyLike> = {}): ReturnType<typeof keyAction> => {
      const action = press(key, extra, now - ledAt < 1500);
      ledAt = ledAfter({ key }, action, ledAt, now);
      now += 100;
      return action;
    };
    expect(step("g")).toEqual({ type: "lead" });
    expect(step("Shift", { shiftKey: true })).toBeNull();
    expect(step("M", { shiftKey: true })).toEqual({ type: "go", place: "map" });
    // Any other key ends the lead.
    expect(step("g")).toEqual({ type: "lead" });
    expect(step("x")).toBeNull();
    expect(step("m")).toBeNull();
  });
});

describe("the names of the keys", () => {
  it("say ⌘ on a Mac and Ctrl everywhere else", () => {
    expect(keyNames(true)).toEqual({ mod: "⌘", undo: "⌘Z", redo: "⇧⌘Z" });
    expect(keyNames(false)).toEqual({ mod: "Ctrl ", undo: "Ctrl+Z", redo: "Ctrl+Shift+Z" });
  });
});

describe("the keys under the palette or the shortcuts sheet", () => {
  it("keep Esc, Cmd or Ctrl K and undo, and drop every single-key action", () => {
    expect(heldByOverlay({ type: "close" })).toBe(false);
    expect(heldByOverlay({ type: "palette" })).toBe(false);
    expect(heldByOverlay({ type: "undo" })).toBe(false);
    for (const key of ["n", "p", "/", "?", "g", "1", "2"]) {
      const action = press(key);
      expect(action).not.toBeNull();
      expect(heldByOverlay(action!)).toBe(true);
    }
    expect(heldByOverlay(press("m", {}, true)!)).toBe(true);
  });
});
