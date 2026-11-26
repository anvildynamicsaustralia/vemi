import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { levelRefusal, levelWords, pluralOf, refusalMessage, spaceMenuWords } from "./levelWords.js";

describe("levelWords", () => {
  it("defaults to Space, Project, Milestone and Task", () => {
    expect(levelWords()).toEqual({
      space: "Space", spaces: "Spaces", project: "Project", projects: "Projects",
      milestone: "Milestone", milestones: "Milestones", task: "Task", tasks: "Tasks",
    });
  });
  it("takes a name a person chose and falls back on a blank one", () => {
    const w = levelWords({ space: "Subject", task: "  " });
    expect(w.space).toBe("Subject");
    expect(w.spaces).toBe("Subjects");
    expect(w.task).toBe("Task");
  });
  it("turns the code's words in a refusal into the account's", () => {
    const w = levelWords({ space: "Subject", project: "Assignment", milestone: "Checkpoint", task: "Chore" });
    expect(levelRefusal("that space does not exist", w)).toBe("that subject does not exist");
    expect(levelRefusal("milestone abc was not found", w)).toBe("checkpoint abc was not found");
    expect(levelRefusal("tasks 12 was not found", w)).toBe("chores 12 was not found");
    expect(levelRefusal("This project is archived", w)).toBe("This assignment is archived");
    expect(levelRefusal("Venture needs a name", w)).toBe("Subject needs a name");
    expect(levelRefusal("spaceship", w)).toBe("spaceship");
  });
  it("leaves a refusal alone under the shipped words", () => {
    expect(levelRefusal("that space does not exist", levelWords())).toBe("that space does not exist");
  });
  it("pluralises a name by its ending", () => {
    expect(pluralOf("Study")).toBe("Studies");
    expect(pluralOf("Class")).toBe("Classes");
    expect(pluralOf("Day")).toBe("Days");
  });
});

describe("every shown refusal goes through the account's words", () => {
  it("refusalMessage converts an Error and a bare value", () => {
    const w = levelWords({ space: "Subject" });
    expect(refusalMessage(new Error("that space does not exist"), w)).toBe("that subject does not exist");
    expect(refusalMessage("This space is archived", w)).toBe("This subject is archived");
  });
  it("a space's menu speaks the account's names, and says venture nowhere by default", () => {
    expect(spaceMenuWords(levelWords({ space: "Subject", task: "Chore" }))).toEqual({
      add: "Add a chore here", about: "About this subject", archive: "Archive subject", noun: "subject",
    });
    expect(Object.values(spaceMenuWords(levelWords())).join(" ")).not.toMatch(/venture/i);
  });
  it("App.tsx never puts a raw refusal in a notice", () => {
    const src = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
    expect(src).not.toMatch(/say\(err instanceof Error/);
    expect(src).not.toMatch(/const said = err instanceof Error/);
    expect(src).not.toMatch(/refused: \$\{why\}/);
    expect(src).toMatch(/levelRefusal\(why, currentWords\(\)\)/);
  });
});
