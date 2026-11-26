import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { moveLines } from "./moveCounts.js";

const words = {
  space: "Realm", spaces: "Realms", project: "Quest", projects: "Quests",
  milestone: "Mark", milestones: "Marks", task: "Chore", tasks: "Chores",
};

describe("moveLines", () => {
  it("speaks in the person's level names, in level order", () => {
    expect(moveLines({ task: 4, venture: 2, project: 1, milestone: 3 }, words)).toEqual([
      "2 Realms", "1 Quest", "3 Marks", "4 Chores",
    ]);
  });
  it("uses the singular for one", () => {
    expect(moveLines({ venture: 1, task: 1 }, words)).toEqual(["1 Realm", "1 Chore"]);
  });
  it("drops empty and left-out kinds", () => {
    expect(moveLines({ venture: 0, note: 9, task: 2, push_subscription: 3 }, words)).toEqual(["2 Chores"]);
  });
  it("answers nothing for nothing", () => {
    expect(moveLines({}, words)).toEqual([]);
  });
  it("types no level name in its own source", () => {
    const source = readFileSync(new URL("./moveCounts.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/\b(Spaces?|Projects?|Milestones?|Tasks?)\b/);
  });
});
