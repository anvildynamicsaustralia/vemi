import { describe, expect, it } from "vitest";
import { liftBy, shiftFor, targetIndex, type Row } from "./dragTarget.js";

/** Four rows of 20px, stacked from 0. */
const even: Row[] = [
  { id: "a", top: 0, height: 20 },
  { id: "b", top: 20, height: 20 },
  { id: "c", top: 40, height: 20 },
  { id: "d", top: 60, height: 20 },
];

/** Today's rows are not all the same height, which is the case the arithmetic must survive. */
const uneven: Row[] = [
  { id: "a", top: 0, height: 10 },
  { id: "b", top: 10, height: 40 },
  { id: "c", top: 50, height: 16 },
];

describe("targetIndex", () => {
  it("stays put when nothing has moved", () => {
    expect(targetIndex(even, 0, 0)).toBe(0);
    expect(targetIndex(even, 2, 0)).toBe(2);
  });

  it("swaps at half a row, not a whole one", () => {
    expect(targetIndex(even, 0, 9)).toBe(0);
    expect(targetIndex(even, 0, 11)).toBe(1);
  });

  it("walks the whole way down and back up", () => {
    expect(targetIndex(even, 0, 60)).toBe(3);
    expect(targetIndex(even, 3, -60)).toBe(0);
  });

  it("does not run off either end", () => {
    expect(targetIndex(even, 0, -500)).toBe(0);
    expect(targetIndex(even, 3, 500)).toBe(3);
  });

  it("uses the slots as they were, when the rows are different heights", () => {
    // 'a' is 10 tall and sits above 'b', which is 40. 'a' takes b's slot as soon as its
    // centre crosses into it, whatever b's height — the slot is the target, not the row.
    expect(targetIndex(uneven, 0, 4)).toBe(0);
    expect(targetIndex(uneven, 0, 6)).toBe(1);
    expect(targetIndex(uneven, 2, -40)).toBe(1);
  });
});

describe("shiftFor", () => {
  it("moves nothing when the row has not changed index", () => {
    expect(shiftFor(even, 1, 1, 0)).toBe(0);
    expect(shiftFor(even, 1, 1, 2)).toBe(0);
  });

  it("lifts the rows the dragged one has passed going down", () => {
    expect(shiftFor(even, 0, 2, 1)).toBe(-20);
    expect(shiftFor(even, 0, 2, 2)).toBe(-20);
    expect(shiftFor(even, 0, 2, 3)).toBe(0);
  });

  it("drops the rows the dragged one has passed going up", () => {
    expect(shiftFor(even, 3, 1, 1)).toBe(20);
    expect(shiftFor(even, 3, 1, 2)).toBe(20);
    expect(shiftFor(even, 3, 1, 0)).toBe(0);
  });

  it("never moves the dragged row by this route", () => {
    expect(shiftFor(even, 0, 3, 0)).toBe(0);
  });

  it("shifts by the dragged row's own height, not the passed row's", () => {
    // 'b' is 40 tall, so passing it moves 'a' and 'c' by 40, whatever they are.
    expect(shiftFor(uneven, 1, 0, 0)).toBe(40);
  });
});

describe("liftBy", () => {
  it("follows the pointer inside the list", () => {
    expect(liftBy(even, 1, 15)).toBe(15);
  });

  it("stops at the top and the bottom of the list", () => {
    expect(liftBy(even, 1, -500)).toBe(-20);
    expect(liftBy(even, 1, 500)).toBe(40);
  });
});
