import { describe, expect, it } from "vitest";
import { projectNext, type NextInput } from "./projectNext.js";

const filled = { description: "a", whoFor: "b", doneLooks: "c", openQuestions: "d" };
const empty = { description: null, whoFor: null, doneLooks: null, openQuestions: null };

const base = (over: Partial<NextInput> = {}): NextInput => ({
  brief: filled,
  milestones: [
    { id: "m1", name: "One" },
    { id: "m2", name: "Two" },
  ],
  tasks: [],
  selectedMilestoneId: null,
  ...over,
});

const task = (id: string, milestoneId: string | null, done = false) => ({
  id,
  title: `T ${id}`,
  milestoneId,
  done,
});

describe("projectNext", () => {
  it("asks for the first empty brief step before anything else", () => {
    expect(projectNext(base({ brief: { ...filled, whoFor: " " }, milestones: [] }))).toEqual({
      kind: "brief",
      step: 1,
    });
    expect(projectNext(base({ brief: empty }))).toEqual({ kind: "brief", step: 0 });
  });

  it("asks for a milestone when there is none", () => {
    expect(projectNext(base({ milestones: [], tasks: [task("a", null)] }))).toEqual({ kind: "milestone" });
  });

  it("takes the selected milestone's first open task", () => {
    const tasks = [task("a", "m1"), task("b", "m2", true), task("c", "m2"), task("d", "m2")];
    expect(projectNext(base({ tasks, selectedMilestoneId: "m2" }))).toEqual({
      kind: "task",
      taskId: "c",
      milestoneId: "m2",
    });
  });

  it("falls to the first open task of any milestone when the selected one has none", () => {
    const tasks = [task("a", "m1", true), task("b", "m2")];
    expect(projectNext(base({ tasks, selectedMilestoneId: "m1" }))).toEqual({
      kind: "task",
      taskId: "b",
      milestoneId: "m2",
    });
  });

  it("with no selection takes the first milestone that has an open task", () => {
    const tasks = [task("a", "m1", true), task("b", "m2")];
    expect(projectNext(base({ tasks }))).toMatchObject({ kind: "task", taskId: "b" });
  });

  it("falls to the first open task with no milestone", () => {
    const tasks = [task("a", "m1", true), task("b", null, true), task("c", null)];
    expect(projectNext(base({ tasks }))).toEqual({ kind: "task", taskId: "c", milestoneId: null });
  });

  it("says add a task when nothing is open", () => {
    expect(projectNext(base({ tasks: [task("a", "m1", true)], selectedMilestoneId: "m2" }))).toEqual({
      kind: "addTask",
      milestoneId: "m2",
    });
    expect(projectNext(base())).toEqual({ kind: "addTask", milestoneId: null });
  });
});
