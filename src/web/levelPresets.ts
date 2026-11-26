/** The name sets Account > Names starts from, and the example path that shows them. Pure. */
import type { LevelNames } from "./levelWords.js";

export interface LevelPreset {
  readonly label: string;
  /** Singular, as stored. */
  readonly names: LevelNames;
}

export const LEVEL_PRESETS: readonly LevelPreset[] = [
  { label: "Work", names: { space: "Venture", project: "Project", milestone: "Milestone", task: "Task" } },
  { label: "Study", names: { space: "Subject", project: "Assignment", milestone: "Checkpoint", task: "Task" } },
  { label: "Life", names: { space: "Area", project: "Project", milestone: "Goal", task: "Task" } },
  { label: "A mix", names: { space: "Space", project: "Project", milestone: "Milestone", task: "Task" } },
];

const same = (a: string, b: string): boolean => a.trim().toLowerCase() === b.trim().toLowerCase();

/** The label of the preset these names match, or null when they are a person's own. */
export function presetOf(names: LevelNames): string | null {
  const hit = LEVEL_PRESETS.find((p) =>
    same(p.names.space, names.space) && same(p.names.project, names.project)
    && same(p.names.milestone, names.milestone) && same(p.names.task, names.task));
  return hit?.label ?? null;
}

const EXAMPLES = ["Anvil Dynamics", "VEMI", "Free hosting", "Deploy button"] as const;

/** One real-looking path through the four levels, each with the word it now wears. */
export function examplePath(names: LevelNames): readonly { readonly word: string; readonly example: string }[] {
  const words = [names.space, names.project, names.milestone, names.task] as const;
  return words.map((word, i) => ({ word, example: EXAMPLES[i] ?? "" }));
}
