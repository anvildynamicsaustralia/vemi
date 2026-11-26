/**
 * What the four levels are called on a screen. Pure.
 *
 * The code, the routes and the API keep "venture", "project", "milestone" and "task"; a
 * person sees these words instead. The defaults are Space, Project, Milestone and Task. The
 * account phase makes `levelWords` read the names a person chose; every screen asks here, so
 * that change is made once.
 */
import { pluralOf } from "@vemi/shared";

export interface LevelNames {
  readonly space: string;
  readonly project: string;
  readonly milestone: string;
  readonly task: string;
}

export interface LevelWords {
  readonly space: string;
  readonly spaces: string;
  readonly project: string;
  readonly projects: string;
  readonly milestone: string;
  readonly milestones: string;
  readonly task: string;
  readonly tasks: string;
}

export const DEFAULT_LEVEL_NAMES: LevelNames = { space: "Space", project: "Project", milestone: "Milestone", task: "Task" };

export { pluralOf };

const named = (given: string | undefined, fallback: string): string => {
  const t = given?.trim() ?? "";
  return t === "" ? fallback : t;
};

/** The words the code's refusals use, singular, and which level each one is. */
const CODE_WORDS: Readonly<Record<string, "space" | "project" | "milestone" | "task">> = {
  venture: "space", space: "space", project: "project", milestone: "milestone", task: "task",
};
const CODE_WORD = /\b(venture|space|project|milestone|task)(s?)\b/gi;

/**
 * A refusal the Worker sent, in this account's words. The store names levels in the code's
 * words ("that space does not exist"); where the web shows one it passes through here. The
 * case of the first letter and a plural carry over.
 */
export function levelRefusal(text: string, words: LevelWords): string {
  return text.replace(CODE_WORD, (found: string, word: string, plural: string) => {
    const level = CODE_WORDS[word.toLowerCase()];
    if (level === undefined) return found;
    const given = plural === "" ? words[level] : words[`${level}s` as const];
    const capital = word[0] === (word[0] ?? "").toUpperCase();
    return `${capital ? (given[0] ?? "").toUpperCase() : (given[0] ?? "").toLowerCase()}${given.slice(1)}`;
  });
}

export function levelWords(names: Partial<LevelNames> = {}): LevelWords {
  const space = named(names.space, DEFAULT_LEVEL_NAMES.space);
  const project = named(names.project, DEFAULT_LEVEL_NAMES.project);
  const milestone = named(names.milestone, DEFAULT_LEVEL_NAMES.milestone);
  const task = named(names.task, DEFAULT_LEVEL_NAMES.task);
  return {
    space, spaces: pluralOf(space),
    project, projects: pluralOf(project),
    milestone, milestones: pluralOf(milestone),
    task, tasks: pluralOf(task),
  };
}

/** The words on a space's own ⋯ menu, in this account's names. */
export function spaceMenuWords(words: LevelWords): { readonly add: string; readonly about: string; readonly archive: string; readonly noun: string } {
  const space = words.space.toLowerCase();
  return {
    add: `Add a ${words.task.toLowerCase()} here`,
    about: `About this ${space}`,
    archive: `Archive ${space}`,
    noun: space,
  };
}

/** What a thrown refusal says, in this account's words: the one road a shown refusal takes. */
export function refusalMessage(err: unknown, words: LevelWords): string {
  return levelRefusal(err instanceof Error ? err.message : String(err), words);
}
