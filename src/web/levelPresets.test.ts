import { describe, expect, it } from "vitest";
import { DEFAULT_LEVEL_NAMES } from "./levelWords.js";
import { LEVEL_PRESETS, examplePath, presetOf } from "./levelPresets.js";

describe("level presets", () => {
  it("offers Work, Study, Life and A mix, stored singular", () => {
    expect(LEVEL_PRESETS.map((p) => p.label)).toEqual(["Work", "Study", "Life", "A mix"]);
    const study = LEVEL_PRESETS.find((p) => p.label === "Study");
    expect(study?.names).toEqual({ space: "Subject", project: "Assignment", milestone: "Checkpoint", task: "Task" });
    expect(LEVEL_PRESETS.find((p) => p.label === "Work")?.names.space).toBe("Venture");
    expect(LEVEL_PRESETS.find((p) => p.label === "Life")?.names.milestone).toBe("Goal");
  });
  it("makes A mix the shipped words", () => {
    expect(LEVEL_PRESETS.find((p) => p.label === "A mix")?.names).toEqual(DEFAULT_LEVEL_NAMES);
  });
  it("finds the preset a set of names matches, ignoring case, else none", () => {
    expect(presetOf({ space: "subject", project: "Assignment", milestone: "Checkpoint", task: "Task" })).toBe("Study");
    expect(presetOf({ ...DEFAULT_LEVEL_NAMES, task: "Chore" })).toBeNull();
  });
  it("draws an example path in the chosen names", () => {
    expect(examplePath({ space: "Subject", project: "Assignment", milestone: "Checkpoint", task: "Task" })).toEqual([
      { word: "Subject", example: "Anvil Dynamics" },
      { word: "Assignment", example: "VEMI" },
      { word: "Checkpoint", example: "Free hosting" },
      { word: "Task", example: "Deploy button" },
    ]);
  });
});
