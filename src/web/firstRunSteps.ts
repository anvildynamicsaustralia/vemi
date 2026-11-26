/**
 * The steps of first run, as facts. Pure.
 *
 * Seven steps: the four names, the first space, a project in it, a task in it, the task put on
 * today, reminders, and (on a phone browser that is not the installed app) the home screen. The
 * bar counts the steps this device will show, so it says 6 or 7. Titles wear the account's level
 * words; the suggestions are plain example names that follow the chosen preset.
 */
import { presetOf } from "./levelPresets.js";
import type { LevelNames, LevelWords } from "./levelWords.js";

export type FirstRunStep = 1 | 2 | 3 | 4 | 5 | 6 | 7;

/** Where a step lives: the map, the space page, the project page or Today. */
export type StepPlace = "map" | "space" | "project" | "today";

export const LAST_STEP: FirstRunStep = 7;

/** A stored number as a step, or null when it is not one of the seven. */
export function asStep(value: unknown): FirstRunStep | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= LAST_STEP
    ? (value as FirstRunStep)
    : null;
}

/**
 * True only on a phone-width browser that is not installed and has an install offer. A copy kept
 * in the page (`local`) also offers Safari's own steps at any width, so an iPad gets them too.
 */
export function homeScreenStep(device: {
  readonly phone: boolean;
  readonly standalone: boolean;
  readonly offer: "button" | "ios" | null;
  readonly local?: boolean;
}): boolean {
  if (device.standalone || device.offer === null) return false;
  return device.phone || (device.local === true && device.offer === "ios");
}

/** How many steps the bar counts on this device. */
export const totalSteps = (homeScreen: boolean): number => (homeScreen ? 7 : 6);

/** The step's title, in the account's words. */
export function stepTitle(step: FirstRunStep, words: LevelWords): string {
  switch (step) {
    case 1: return "What are you using VEMI for?";
    case 2: return `Name your first ${words.space.toLowerCase()}`;
    case 3: return `Add a ${words.project.toLowerCase()} to it`;
    case 4: return `Add a ${words.task.toLowerCase()} to it`;
    case 5: return "Put it on today";
    case 6: return "Want VEMI to remind you?";
    case 7: return "Add VEMI to your home screen";
  }
}

/** Which screen the step is done on. */
export function stepPlace(step: FirstRunStep): StepPlace {
  switch (step) {
    case 1: case 2: return "map";
    case 3: return "space";
    case 4: return "project";
    case 5: case 6: case 7: return "today";
  }
}

const SUGGESTIONS = {
  Work: ["My business", "Website", "Draft the home page tomorrow"],
  Study: ["Biology", "Lab report", "Read chapter 3 tomorrow"],
  Life: ["Home", "Garden", "Buy seedlings tomorrow"],
} as const;

/**
 * The placeholder for steps 2 to 4 (space, project, task), by the preset the names match. A
 * person's own names, and A mix, take the Life examples. Other steps have none.
 */
export function stepSuggestion(step: FirstRunStep, names: LevelNames): string | null {
  if (step < 2 || step > 4) return null;
  const label = presetOf(names);
  const set = label === "Work" || label === "Study" ? SUGGESTIONS[label] : SUGGESTIONS.Life;
  return set[step - 2] ?? null;
}

/** The step after this one on this device, or null when first run is over. */
export function nextStep(step: FirstRunStep, homeScreen: boolean): FirstRunStep | null {
  if (step >= 7) return null;
  if (step === 6) return homeScreen ? 7 : null;
  return (step + 1) as FirstRunStep;
}

/** The bar's label: "Step 2 of 6". */
export function stepLabel(step: FirstRunStep, homeScreen: boolean): string {
  const total = totalSteps(homeScreen);
  return `Step ${Math.min(step, total)} of ${total}`;
}
