import { describe, expect, it } from "vitest";
import type { ChecklistItem } from "@vemi/shared";
import { checklistCount } from "./checklistCount.js";

const list = (...done: readonly boolean[]): readonly ChecklistItem[] =>
  done.map((d, i) => ({ text: `step ${i + 1}`, done: d }));

describe("checklistCount", () => {
  it("says nothing at all for a list with nothing in it", () => {
    expect(checklistCount([])).toEqual({ done: 0, of: 0, said: "" });
  });

  it("counts one item, ticked and not", () => {
    expect(checklistCount(list(false))).toEqual({ done: 0, of: 1, said: "0 of 1" });
    expect(checklistCount(list(true))).toEqual({ done: 1, of: 1, said: "1 of 1" });
  });

  it("counts none of them done", () => {
    expect(checklistCount(list(false, false, false))).toEqual({ done: 0, of: 3, said: "0 of 3" });
  });

  it("counts all of them done", () => {
    expect(checklistCount(list(true, true, true))).toEqual({ done: 3, of: 3, said: "3 of 3" });
  });

  it("prints the sentence the sheet and the card both show", () => {
    expect(checklistCount(list(true, false, true, false, false, true, false)).said).toBe("3 of 7");
  });

  it("counts what is ticked wherever it sits in the list", () => {
    expect(checklistCount(list(false, true, false)).done).toBe(1);
    expect(checklistCount(list(true, false, false)).done).toBe(1);
    expect(checklistCount(list(false, false, true)).done).toBe(1);
  });
});
