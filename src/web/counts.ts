/**
 * The two figures the rebuild draws: how much is left, as a ring, and how much is done, as
 * a dot matrix. Pure.
 *
 * Left is counted exactly as the Worker counts a venture's tasks left, so a ring never
 * disagrees with a number printed elsewhere: a task that is not finished, including one
 * with no state yet. Done is a finished task.
 */
import type { StateKind, TreeProject, TreeVenture } from "@vemi/shared";

export interface Counts {
  readonly left: number;
  readonly done: number;
}

interface Countable {
  readonly stateId: string | null;
}

export function countTasks(tasks: readonly Countable[], kinds: ReadonlyMap<string, StateKind>): Counts {
  let left = 0;
  let done = 0;
  for (const t of tasks) {
    if ((t.stateId === null ? undefined : kinds.get(t.stateId)) === "finished") done++;
    else left++;
  }
  return { left, done };
}

export const kindsOf = (v: Pick<TreeVenture, "states">): Map<string, StateKind> => new Map(v.states.map((s) => [s.id, s.kind]));

export function projectCounts(p: Pick<TreeProject, "tasks">, kinds: ReadonlyMap<string, StateKind>): Counts {
  return countTasks(p.tasks, kinds);
}

/** How much of the ring is drawn: what is left, of everything counted. */
export function leftShare(c: Counts): number {
  const all = c.left + c.done;
  return all === 0 ? 0 : c.left / all;
}
