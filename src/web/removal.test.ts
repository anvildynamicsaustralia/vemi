import { describe, expect, it } from "vitest";
import type { Removal } from "@vemi/shared";
import { alsoRemoved } from "./removal.js";

const none: Removal = {
  ventures: 0, states: 0, stages: 0, projects: 0, milestones: 0,
  tasks: 0, blockers: 0, notes: 0, decisions: 0, risks: 0, links: 0,
  tags: 0, taskTags: 0, projectTags: 0,
};

describe("alsoRemoved", () => {
  it("says the projects inside a parent project, and still drops the parent itself", () => {
    expect(alsoRemoved("projects", { ...none, projects: 3 })).toEqual(["2 projects inside it"]);
    expect(alsoRemoved("projects", { ...none, projects: 2, tasks: 1 })).toEqual(["1 project inside it", "1 task"]);
  });

  it("leaves a childless project's sheet unchanged", () => {
    expect(alsoRemoved("projects", { ...none, projects: 1, tasks: 3 })).toEqual(["3 tasks"]);
  });

  it("names a venture's whole cascade, containers first", () => {
    expect(alsoRemoved("ventures", {
      ...none, ventures: 1, projects: 2, milestones: 1, tasks: 14, states: 3,
      blockers: 1, notes: 4, links: 1,
    })).toEqual([
      "2 projects", "1 milestone", "14 tasks", "3 states",
      "1 blocker", "4 notes", "1 link",
    ]);
  });

  it("leaves out the record itself, which the sheet has already named", () => {
    expect(alsoRemoved("tasks", { ...none, tasks: 1 })).toEqual([]);
    expect(alsoRemoved("projects", { ...none, projects: 1, tasks: 3 })).toEqual(["3 tasks"]);
  });

  it("says one of a thing in the singular", () => {
    expect(alsoRemoved("tasks", { ...none, tasks: 1, notes: 1, links: 1 })).toEqual(["1 note", "1 link"]);
    expect(alsoRemoved("tasks", { ...none, tasks: 1, notes: 2 })).toEqual(["2 notes"]);
  });

  it("is empty for something that takes nothing with it", () => {
    expect(alsoRemoved("notes", none)).toEqual([]);
  });

  it("names an assignment as a tag coming off, never as the thing it was on", () => {
    expect(alsoRemoved("tags", { ...none, tags: 1, taskTags: 3, projectTags: 1 }))
      .toEqual(["its place on 3 tasks", "its place on 1 project"]);
    expect(alsoRemoved("tasks", { ...none, tasks: 1, taskTags: 1 })).toEqual(["1 tag on it"]);
  });

  it("says a task's two tags as tags on it, never as tags on other tasks", () => {
    const said = alsoRemoved("tasks", { ...none, tasks: 1, taskTags: 2 });
    expect(said).toEqual(["2 tags on it"]);
    expect(said.join(" ")).not.toMatch(/tasks/);
  });

  it("scopes a container's assignments to its own tasks and projects", () => {
    expect(alsoRemoved("projects", { ...none, projects: 1, tasks: 2, taskTags: 3, projectTags: 2 }))
      .toEqual(["2 tasks", "3 tags on its tasks", "2 tags on it"]);
    expect(alsoRemoved("ventures", { ...none, ventures: 1, projects: 1, taskTags: 1, projectTags: 2 }))
      .toEqual(["1 project", "1 tag on its tasks", "2 tags on its projects"]);
  });
});
