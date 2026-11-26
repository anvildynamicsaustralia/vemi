/**
 * Gathering what is coming, and what is not. Pure: the tree and the day's own response
 * in, the neutral rows `bandsOf` bands out.
 *
 * No new read path. `tree()` already returns every venture's tasks and every project's
 * milestones, and the shell already fetches it, so Today costs nothing extra. The work
 * here is entirely the exclusions, and each one answers a decision:
 *
 * - A finished task is behind you, and so is a finished milestone. The map's next
 *   milestone already skips a finished one (`store.ts`, `open_milestones`); without the
 *   same rule here, a milestone finished months ago would sit under Today for good.
 * - Anything undated is left out: Today looks ahead at what is coming, and something with no date
 *   is not coming, it is waiting.
 *
 * Overdue is never worked out. It is read off the `/api/today` row of the same id, the
 * way the needs-you panel reads it, because `store.today()` is the one place a date is
 * compared with today. A milestone is never given the flag at all.
 */
import type { DateOnly, Today, Tree } from "@vemi/shared";
import { kindOf, tasksOf } from "./treeIndex.js";

/** One thing with a date, as a task or a milestone: the neutral row every reader of the tree shares. */
export interface Coming {
  readonly id: string;
  readonly kind: "task" | "milestone";
  readonly date: DateOnly;
  readonly ventureId: string;
  readonly title: string;
  /** Only a task can be overdue, and only because `/api/today` said so. */
  readonly overdue: boolean;
}

/** Every dated, unfinished task and every dated, unfinished milestone, across every venture. */
export function comingUp(tree: Tree, today: Today | null): readonly Coming[] {
  const flagged = new Set<string>();
  for (const row of today?.tasks ?? []) if (row.overdue) flagged.add(row.id);

  const out: Coming[] = [];
  for (const venture of tree.ventures) {
    // `tasksOf` is a union of a venture's own tasks and its projects', not a visibility
    // filter: everything it holds back is held back below.
    for (const task of tasksOf(venture)) {
      if (kindOf(task, venture) === "finished") continue;
      const date = task.dueOn;
      if (date === null) continue;
      out.push({
        id: task.id,
        kind: "task",
        date,
        ventureId: venture.id,
        title: task.title,
        overdue: flagged.has(task.id),
      });
    }
    for (const project of venture.projects) {
      for (const milestone of project.milestones) {
        // A finished milestone is behind you, exactly as a finished task is. Its date is
        // soft either way; this is about its state, never about the date.
        const kind = milestone.stateId === null ? null : venture.states.find((s) => s.id === milestone.stateId)?.kind;
        if (kind === "finished") continue;
        const date = milestone.aimingOn;
        if (date === null) continue;
        out.push({
          id: milestone.id,
          kind: "milestone",
          date,
          ventureId: venture.id,
          title: milestone.name,
          // Soft, and never judged: a milestone carries no lateness, here or anywhere.
          overdue: false,
        });
      }
    }
  }
  return out;
}
