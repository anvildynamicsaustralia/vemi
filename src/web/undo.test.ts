import { describe, expect, it } from "vitest";
import { NOTHING, canRedo, canUndo, did, forget, LIMIT, nextUndo, redoing, saidFor, undoing } from "./undo.js";

const step = (what: string) => ({ what, undo: async () => what, redo: async () => what });

describe("undo", () => {
  it("has nothing to undo or redo when nothing has happened", () => {
    expect(canUndo(NOTHING)).toBe(false);
    expect(canRedo(NOTHING)).toBe(false);
    expect(nextUndo(NOTHING)).toBe(null);
  });

  it("undoes the most recent thing first", () => {
    const u = did(did(NOTHING, step("first")), step("second"));
    const { next, step: ran } = undoing(u);
    expect(ran?.what).toBe("second");
    expect(nextUndo(next)?.what).toBe("first");
  });

  it("runs the one step a notice names, or nothing when another is on top", () => {
    const moved = step("moved to Done");
    const ticked = step("ticked a step");
    const u = did(NOTHING, moved);
    expect(undoing(u, moved).step).toBe(moved);
    const later = did(u, ticked);
    const pressed = undoing(later, moved);
    expect(pressed.step).toBe(null);
    expect(pressed.next).toBe(later);
    const back = undoing(u, moved).next;
    expect(redoing(back, moved).step).toBe(moved);
    expect(redoing(back, ticked).step).toBe(null);
  });

  it("says what it undid and redid, and when the way back was only kept", () => {
    const moved = step("moved Glaze to Done");
    expect(saidFor("undo", moved, null)).toBe("Undid: moved Glaze to Done.");
    expect(saidFor("redo", moved, null)).toBe("Redid: moved Glaze to Done.");
    expect(saidFor("undo", moved, "Kept on this device.")).toBe("Undid: moved Glaze to Done. Kept on this device.");
  });

  it("redoes what it just undid", () => {
    const u = did(NOTHING, step("moved VEMI"));
    const after = undoing(u).next;
    expect(canRedo(after)).toBe(true);
    const { next, step: ran } = redoing(after);
    expect(ran?.what).toBe("moved VEMI");
    expect(canRedo(next)).toBe(false);
    expect(canUndo(next)).toBe(true);
  });

  it("drops the redo trail once something new is done", () => {
    // Redoing into a world that has moved on since is the one thing this must not offer.
    const undoneOne = undoing(did(NOTHING, step("a"))).next;
    expect(canRedo(undoneOne)).toBe(true);
    expect(canRedo(did(undoneOne, step("b")))).toBe(false);
  });

  it("keeps the stack to a limit, oldest first", () => {
    let u = NOTHING;
    for (let i = 0; i < LIMIT + 10; i++) u = did(u, step(`step ${i}`));
    expect(u.done.length).toBe(LIMIT);
    expect(u.done[0]?.what).toBe("step 10");
  });

  it("forgets a step whose undo the Worker refused", () => {
    const bad = step("refused");
    const u = did(did(NOTHING, step("kept")), bad);
    const after = undoing(u);
    expect(canRedo(after.next)).toBe(true);
    const cleaned = forget(after.next, bad);
    expect(canRedo(cleaned)).toBe(false);
    expect(nextUndo(cleaned)?.what).toBe("kept");
  });

  it("does nothing at all when there is nothing to undo", () => {
    const { next, step: ran } = undoing(NOTHING);
    expect(ran).toBe(null);
    expect(next).toBe(NOTHING);
  });
});
