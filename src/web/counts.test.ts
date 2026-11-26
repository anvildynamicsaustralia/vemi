import { describe, expect, it } from "vitest";
import type { StateKind } from "@vemi/shared";
import { countTasks, leftShare } from "./counts.js";

const kinds = new Map<string, StateKind>([["n", "not_started"], ["u", "underway"], ["f", "finished"]]);
const t = (stateId: string | null) => ({ stateId });

describe("counts", () => {
  it("counts left as the Worker does: not finished, no state included", () => {
    expect(countTasks([t("n"), t("u"), t(null), t("f")], kinds))
      .toEqual({ left: 3, done: 1 });
  });

  it("treats a state it does not know as not finished", () => {
    expect(countTasks([t("gone")], kinds)).toEqual({ left: 1, done: 0 });
  });

  it("draws the ring as the share left, and nothing when there is nothing", () => {
    expect(leftShare({ left: 3, done: 1 })).toBe(0.75);
    expect(leftShare({ left: 0, done: 0 })).toBe(0);
    expect(leftShare({ left: 0, done: 4 })).toBe(0);
  });
});
