import { describe, expect, it } from "vitest";
import type { StateKind } from "@vemi/shared";
import { milestoneGroups, remainingWords } from "./milestoneGroups.js";

const kinds = new Map<string, StateKind>([["open", "not_started"], ["fin", "finished"]]);
const task = (id: string, milestoneId: string | null, stateId: string | null, position = 0) =>
  ({ id, milestoneId, stateId, position, createdAt: `2026-11-0${position + 1}` });
const milestone = (id: string) => ({ id, name: id });

describe("milestoneGroups", () => {
  it("puts each task under its milestone, in position order, and the rest under none", () => {
    const g = milestoneGroups(
      { milestones: [milestone("m1"), milestone("m2")], tasks: [task("b", "m1", "open", 1), task("a", "m1", "fin", 0), task("c", null, null), task("d", "gone", "open")] },
      kinds,
    );
    expect(g.milestones.map((m) => m.tasks.map((t) => t.id))).toEqual([["a", "b"], []]);
    expect(g.none.tasks.map((t) => t.id)).toEqual(["c", "d"]);
  });

  it("counts left and done the way a project does, with no state counting as left", () => {
    const g = milestoneGroups(
      { milestones: [milestone("m1")], tasks: [task("a", "m1", "fin"), task("b", "m1", null), task("c", "m1", "open")] },
      kinds,
    );
    expect(g.milestones[0]?.counts).toEqual({ left: 2, done: 1 });
  });
});

describe("remainingWords", () => {
  it("says N left, or Done when something was there and all of it is finished", () => {
    expect(remainingWords({ left: 3, done: 1 })).toBe("3 left");
    expect(remainingWords({ left: 0, done: 2 })).toBe("Done");
    expect(remainingWords({ left: 0, done: 0 })).toBe("0 left");
  });
});
