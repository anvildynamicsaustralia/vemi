import { describe, expect, it } from "vitest";
import {
  asStep, homeScreenStep, nextStep, stepLabel, stepPlace, stepSuggestion, stepTitle, totalSteps,
  type FirstRunStep,
} from "./firstRunSteps.js";
import { LEVEL_PRESETS } from "./levelPresets.js";
import { levelWords } from "./levelWords.js";

const STEPS: readonly FirstRunStep[] = [1, 2, 3, 4, 5, 6, 7];

describe("titles", () => {
  it("wear every preset's words for steps 2 to 4", () => {
    for (const preset of LEVEL_PRESETS) {
      const w = levelWords(preset.names);
      expect(stepTitle(2, w)).toBe(`Name your first ${preset.names.space.toLowerCase()}`);
      expect(stepTitle(3, w)).toBe(`Add a ${preset.names.project.toLowerCase()} to it`);
      expect(stepTitle(4, w)).toBe(`Add a ${preset.names.task.toLowerCase()} to it`);
    }
  });
  it("keep the fixed titles", () => {
    const w = levelWords();
    expect(STEPS.map((s) => stepTitle(s, w))).toEqual([
      "What are you using VEMI for?", "Name your first space", "Add a project to it", "Add a task to it",
      "Put it on today", "Want VEMI to remind you?", "Add VEMI to your home screen",
    ]);
  });
  it("follow a person's own names", () => {
    const w = levelWords({ space: "Realm", task: "Chore" });
    expect(stepTitle(2, w)).toBe("Name your first realm");
    expect(stepTitle(4, w)).toBe("Add a chore to it");
  });
});

describe("places", () => {
  it("put each step on its screen", () => {
    expect(STEPS.map(stepPlace)).toEqual(["map", "map", "space", "project", "today", "today", "today"]);
  });
});

describe("suggestions", () => {
  it("follow the preset for steps 2 to 4 and give none elsewhere", () => {
    const by = Object.fromEntries(
      LEVEL_PRESETS.map((p) => [p.label, ([2, 3, 4] as const).map((s) => stepSuggestion(s, p.names))]),
    );
    expect(by["Work"]).toEqual(["My business", "Website", "Draft the home page tomorrow"]);
    expect(by["Study"]).toEqual(["Biology", "Lab report", "Read chapter 3 tomorrow"]);
    expect(by["Life"]).toEqual(["Home", "Garden", "Buy seedlings tomorrow"]);
    expect(by["A mix"]).toEqual(by["Life"]);
    const names = LEVEL_PRESETS[0]!.names;
    expect(([1, 5, 6, 7] as const).map((s) => stepSuggestion(s, names))).toEqual([null, null, null, null]);
  });
  it("take the Life examples for a person's own names", () => {
    expect(stepSuggestion(2, { space: "Realm", project: "Quest", milestone: "Leg", task: "Chore" })).toBe("Home");
  });
});

describe("totals and the next step", () => {
  it("count 6, or 7 where the home screen applies", () => {
    expect(totalSteps(false)).toBe(6);
    expect(totalSteps(true)).toBe(7);
    expect(stepLabel(2, false)).toBe("Step 2 of 6");
    expect(stepLabel(7, true)).toBe("Step 7 of 7");
  });
  it("walks the steps and ends after 6, or after 7", () => {
    expect(([1, 2, 3, 4, 5] as const).map((s) => nextStep(s, false))).toEqual([2, 3, 4, 5, 6]);
    expect(nextStep(6, false)).toBeNull();
    expect(nextStep(6, true)).toBe(7);
    expect(nextStep(7, true)).toBeNull();
  });
});

describe("the home screen step", () => {
  it("applies only on a phone browser, not installed, with an offer", () => {
    expect(homeScreenStep({ phone: true, standalone: false, offer: "ios" })).toBe(true);
    expect(homeScreenStep({ phone: true, standalone: false, offer: "button" })).toBe(true);
    expect(homeScreenStep({ phone: true, standalone: false, offer: null })).toBe(false);
    expect(homeScreenStep({ phone: true, standalone: true, offer: "ios" })).toBe(false);
    expect(homeScreenStep({ phone: false, standalone: false, offer: "button" })).toBe(false);
  });

  it("in local mode also shows on an iPad, which is wider than a phone, but only for Safari's own steps", () => {
    expect(homeScreenStep({ phone: false, standalone: false, offer: "ios", local: true })).toBe(true);
    expect(homeScreenStep({ phone: false, standalone: false, offer: "button", local: true })).toBe(false);
    expect(homeScreenStep({ phone: false, standalone: false, offer: "ios" })).toBe(false);
  });

  it("never shows in the installed app, in local mode too", () => {
    expect(homeScreenStep({ phone: true, standalone: true, offer: "ios", local: true })).toBe(false);
    expect(homeScreenStep({ phone: false, standalone: true, offer: "ios", local: true })).toBe(false);
  });
});

describe("asStep", () => {
  it("accepts 1 to 7 only", () => {
    expect([0, 1, 7, 8, 2.5, "3", null].map(asStep)).toEqual([null, 1, 7, null, null, null, null]);
  });
});
