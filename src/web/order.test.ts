import { describe, expect, it } from "vitest";
import { place, reorder, step, type Placed, type Placement } from "./order.js";

const item = (id: string, position: number): Placed => ({ id, position, createdAt: "2026-09-15T00:00:00Z" });

/** The order after writing the placements, as ids. */
function after(items: readonly Placed[], placements: readonly Placement[]): string[] {
  const moved = new Map(placements.map((p) => [p.id, p.position]));
  return [...items]
    .map((i) => ({ ...i, position: moved.get(i.id) ?? i.position }))
    .sort((a, b) => a.position - b.position)
    .map((i) => i.id);
}

describe("reorder", () => {
  const list = [item("a", 1), item("b", 2), item("c", 3), item("d", 4)];

  it("writes one record, halfway between its new neighbours", () => {
    const moves = reorder(list, "d", 1);
    expect(moves).toEqual([{ id: "d", position: 1.5 }]);
    expect(after(list, moves)).toEqual(["a", "d", "b", "c"]);
  });

  it("moves to the top and to the bottom", () => {
    expect(after(list, reorder(list, "c", 0))).toEqual(["c", "a", "b", "d"]);
    expect(after(list, reorder(list, "a", 99))).toEqual(["b", "c", "d", "a"]);
  });

  it("writes nothing when nothing moves", () => {
    expect(reorder(list, "b", 1)).toEqual([]);
    expect(reorder(list, "nope", 0)).toEqual([]);
  });

  it("numbers the list again when neighbours share a position, writing only what changes", () => {
    const tied = [item("a", 0), item("b", 0), item("c", 0)];
    const moves = reorder(tied, "c", 1);
    expect(after(tied, moves)).toEqual(["a", "c", "b"]);
    expect(moves.map((m) => m.id).sort()).toEqual(["a", "b", "c"]);
    const numbered = [item("a", 1), item("x", 1.0000000000000002), item("b", 2)];
    expect(after(numbered, reorder(numbered, "b", 1))).toEqual(["a", "b", "x"]);
  });
});

describe("step", () => {
  const list = [item("a", 1), item("b", 2), item("c", 3)];

  it("moves one place up or down, and not past either end", () => {
    expect(after(list, step(list, "b", -1))).toEqual(["b", "a", "c"]);
    expect(after(list, step(list, "b", 1))).toEqual(["a", "c", "b"]);
    expect(step(list, "a", -1)).toEqual([]);
    expect(step(list, "c", 1)).toEqual([]);
  });
});

describe("place", () => {
  it("puts a record from elsewhere into a list, at the end or before one", () => {
    const column = [item("a", 1), item("b", 2)];
    expect(place(column, "new", 2)).toEqual([{ id: "new", position: 3 }]);
    expect(place(column, "new", 0)).toEqual([{ id: "new", position: 0 }]);
    expect(place([], "new", 0)).toEqual([{ id: "new", position: 1 }]);
  });
});
