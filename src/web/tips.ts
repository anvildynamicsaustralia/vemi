/**
 * The one list of tips. Each screen has at most one: a short line in the account's own words
 * that names a real feature beside the thing it names. A tip shows only once first run has
 * ended, only while its name is not in `tipsSeen` (null shows none), and never on a phone when
 * it is about a key. Tapping it, or using what it names, marks it seen for good.
 */
import { tipDue, type FirstRun } from "./firstRunState.js";
import type { LevelWords } from "./levelWords.js";

export type TipName = "map" | "today" | "project" | "search" | "lock";

/** The longest a tip may be, in characters. A line that runs longer with long names is not shown. */
export const TIP_MOST = 60;

export interface Tip {
  readonly name: TipName;
  readonly line: (words: LevelWords) => string;
  /** About a key, so a phone never shows it. */
  readonly deskOnly: boolean;
  /** True when the Extras switch for the feature it names is on. */
  readonly needs: (extras: { readonly smartDates: boolean }) => boolean;
}

export const TIPS: readonly Tip[] = [
  { name: "map", line: (w) => `Pin ${w.projects.toLowerCase()} to keep them first.`, deskOnly: false, needs: () => true },
  {
    name: "today",
    line: (w) => `Type "tomorrow" or "every friday" in the ${w.task.toLowerCase()} to date it.`,
    deskOnly: false,
    needs: (x) => x.smartDates,
  },
  { name: "project", line: (w) => `Edit this ${w.project.toLowerCase()}'s name, brief and dates in place.`, deskOnly: false, needs: () => true },
  { name: "search", line: () => "Save a search as a filter.", deskOnly: false, needs: () => true },
  { name: "lock", line: () => "Lock it to keep it for your eyes only.", deskOnly: false, needs: () => true },
];

export interface TipFacts {
  readonly words: LevelWords;
  readonly phone: boolean;
  readonly smartDates: boolean;
  readonly state: FirstRun;
}

/** The line to show for this tip now, or null when it should not show. */
export function tipFor(name: TipName, facts: TipFacts, list: readonly Tip[] = TIPS): string | null {
  const tip = list.find((t) => t.name === name);
  if (tip === undefined) return null;
  if (facts.state.step !== null || !tipDue(facts.state, name)) return null;
  if (tip.deskOnly && facts.phone) return null;
  if (!tip.needs({ smartDates: facts.smartDates })) return null;
  const line = tip.line(facts.words);
  return line.length > TIP_MOST ? null : line;
}
