import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DEFAULT_LEVEL_NAMES } from "./levelWords.js";
import { currentWords, readLevelNames, setLevelNames, storedLevelNames, toStoredNames, useLevelWords } from "./levelNames.js";

describe("readLevelNames", () => {
  it("takes the four names from the account's answer", () => {
    expect(readLevelNames({ levelNames: { space: "Area", project: "Project", milestone: "Goal", task: "Task" } }))
      .toEqual({ space: "Area", project: "Project", milestone: "Goal", task: "Task" });
  });
  it("falls back on the shipped word for anything missing or unusable", () => {
    expect(readLevelNames({ levelNames: { space: 4, project: "  ", task: "Chore" } }))
      .toEqual({ ...DEFAULT_LEVEL_NAMES, task: "Chore" });
    expect(readLevelNames(null)).toEqual(DEFAULT_LEVEL_NAMES);
    expect(readLevelNames({})).toEqual(DEFAULT_LEVEL_NAMES);
  });
});

describe("the copy kept on this device", () => {
  it("round trips and never throws", () => {
    const names = { space: "Area", project: "Project", milestone: "Goal", task: "Task" };
    expect(storedLevelNames(toStoredNames(names))).toEqual(names);
    expect(storedLevelNames("{not json")).toEqual(DEFAULT_LEVEL_NAMES);
    expect(storedLevelNames(null)).toEqual(DEFAULT_LEVEL_NAMES);
  });
});

describe("the words hook", () => {
  const Probe = () => {
    const w = useLevelWords();
    return createElement("p", null, `${w.spaces}/${w.project}`);
  };
  it("gives the shipped words until names are set, then the set names", () => {
    expect(currentWords().space).toBe("Space");
    expect(renderToStaticMarkup(createElement(Probe))).toContain("Spaces/Project");
    setLevelNames({ space: "Subject", project: "Assignment", milestone: "Checkpoint", task: "Task" });
    expect(currentWords().spaces).toBe("Subjects");
    expect(renderToStaticMarkup(createElement(Probe))).toContain("Subjects/Assignment");
    setLevelNames(DEFAULT_LEVEL_NAMES);
  });
});
