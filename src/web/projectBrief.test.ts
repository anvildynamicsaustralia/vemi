import { describe, expect, it } from "vitest";
import { projectBrief } from "./projectBrief.js";

const empty = { description: null, whoFor: null, doneLooks: null, openQuestions: null };

describe("projectBrief", () => {
  it("returns the four steps in order with label, placeholder and value", () => {
    const { steps } = projectBrief({ ...empty, description: "One line" });
    expect(steps.map((s) => s.label)).toEqual([
      "What is it",
      "Who it's for",
      "What done looks like",
      "Open questions",
    ]);
    expect(steps.map((s) => s.placeholder)).toEqual([
      "One line anyone would get",
      "Who uses it and why",
      "How you'll know it's finished",
      "What's still undecided",
    ]);
    expect(steps[0]?.value).toBe("One line");
    expect(steps[1]?.value).toBe("");
  });

  it("counts none filled and points at the first step", () => {
    expect(projectBrief(empty)).toMatchObject({ filled: 0, firstEmpty: 0 });
  });

  it("points at the first empty step, not the last", () => {
    const b = projectBrief({ ...empty, description: "a", doneLooks: "c" });
    expect(b.filled).toBe(2);
    expect(b.firstEmpty).toBe(1);
  });

  it("treats blank and whitespace as empty", () => {
    const b = projectBrief({ description: "  \n", whoFor: "", doneLooks: null, openQuestions: "x" });
    expect(b.filled).toBe(1);
    expect(b.firstEmpty).toBe(0);
  });

  it("gives -1 when all four are filled", () => {
    const b = projectBrief({ description: "a", whoFor: "b", doneLooks: "c", openQuestions: "d" });
    expect(b).toMatchObject({ filled: 4, firstEmpty: -1 });
  });
});
