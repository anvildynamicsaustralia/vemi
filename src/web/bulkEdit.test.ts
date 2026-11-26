import { describe, expect, it } from "vitest";
import { applyTo, changing, counted, revert, tagChange, ventureMoves } from "./bulkEdit.js";

const tasks = [
  { id: "a", stateId: "todo", priority: "high" },
  { id: "b", stateId: "doing", priority: null },
  { id: "c", stateId: "todo", priority: "low" },
];

describe("revert", () => {
  it("remembers what each record had, not what the first one had", () => {
    // The whole point: three tasks in two states go back to their own two states.
    expect(revert(tasks, { stateId: "done" })).toEqual([
      { id: "a", patch: { stateId: "todo" } },
      { id: "b", patch: { stateId: "doing" } },
      { id: "c", patch: { stateId: "todo" } },
    ]);
  });

  it("records a missing value as null, so undo clears it again", () => {
    expect(revert(tasks, { priority: "high" })[1]).toEqual({ id: "b", patch: { priority: null } });
  });

  it("remembers every key the patch touches", () => {
    expect(revert(tasks, { ventureId: "v", projectId: null })[0]?.patch).toEqual({ ventureId: null, projectId: null });
  });
});

describe("changing", () => {
  it("leaves out the records already in the wanted state", () => {
    expect(changing(tasks, { stateId: "todo" }).map((t) => t.id)).toEqual(["b"]);
  });

  it("is empty when the change would do nothing", () => {
    expect(changing([tasks[0]!], { stateId: "todo", priority: "high" })).toEqual([]);
  });

  it("treats undefined and null as the same absence", () => {
    expect(changing(tasks, { priority: null }).map((t) => t.id)).toEqual(["a", "c"]);
  });
});

describe("applyTo", () => {
  it("gives every record the same patch", () => {
    expect(applyTo(tasks, { priority: "low" })).toEqual([
      { id: "a", patch: { priority: "low" } },
      { id: "b", patch: { priority: "low" } },
      { id: "c", patch: { priority: "low" } },
    ]);
  });
});

describe("a bulk project move, which takes the milestone with it", () => {
  // The Worker nulls `milestone_id` whenever `project_id` changes, named in the patch or
  // not. So the forward write names it, and the way back names it too — a way back
  // carrying `projectId` alone would restore the project and clear the milestone again,
  // and the assignment would be gone with nothing left to undo. The board's drop does the
  // same thing, at `moveAcross`.
  const onMilestones = [
    { id: "a", projectId: "ops", milestoneId: "m1" },
    { id: "b", projectId: "ops", milestoneId: "m2" },
    { id: "c", projectId: "studio", milestoneId: null },
  ];
  const move = { projectId: "studio" };
  const takes = { milestoneId: null };

  it("counts only the project as the change, so standing still costs no milestone", () => {
    expect(changing(onMilestones, move).map((t) => t.id)).toEqual(["a", "b"]);
  });

  it("writes the milestone away and remembers each record's own", () => {
    const real = changing(onMilestones, move);
    expect(applyTo(real, { ...move, ...takes })[0]?.patch).toEqual({ projectId: "studio", milestoneId: null });
    expect(revert(real, { ...move, ...takes })).toEqual([
      { id: "a", patch: { projectId: "ops", milestoneId: "m1" } },
      { id: "b", patch: { projectId: "ops", milestoneId: "m2" } },
    ]);
  });
});

describe("counted", () => {
  it("says one task and three tasks", () => {
    expect(counted(1, "task")).toBe("1 task");
    expect(counted(3, "task")).toBe("3 tasks");
    expect(counted(2, "venture")).toBe("2 ventures");
  });
});

describe("tagChange", () => {
  const tagged = [
    { id: "a", tagIds: ["legal"] },
    { id: "b", tagIds: [] as string[] },
    { id: "c", tagIds: ["legal", "art"] },
  ];

  it("puts a tag on only the records without it, and each goes back to its own list", () => {
    expect(tagChange(tagged, "art", true)).toEqual({
      forward: [{ id: "a", patch: { tagIds: ["legal", "art"] } }, { id: "b", patch: { tagIds: ["art"] } }],
      back: [{ id: "a", patch: { tagIds: ["legal"] } }, { id: "b", patch: { tagIds: [] } }],
    });
  });

  it("takes a tag off only the records carrying it", () => {
    expect(tagChange(tagged, "legal", false)).toEqual({
      forward: [{ id: "a", patch: { tagIds: [] } }, { id: "c", patch: { tagIds: ["art"] } }],
      back: [{ id: "a", patch: { tagIds: ["legal"] } }, { id: "c", patch: { tagIds: ["legal", "art"] } }],
    });
  });
});

describe("ventureMoves", () => {
  it("sends the venture alone, the way one task moves, and the way back restores project, milestone and state", () => {
    const moving = [
      { id: "a", ventureId: "v1", projectId: "p", milestoneId: "m", stateId: "s1" },
      { id: "b", ventureId: "v2", projectId: null, milestoneId: null, stateId: "s2" },
    ];
    expect(ventureMoves(moving, "v2")).toEqual({
      forward: [{ id: "a", patch: { ventureId: "v2" } }],
      back: [{ id: "a", patch: { ventureId: "v1", projectId: "p", milestoneId: "m", stateId: "s1" } }],
    });
  });
});
