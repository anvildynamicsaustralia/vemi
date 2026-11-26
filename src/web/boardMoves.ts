/**
 * What a drag on the board writes, and what the board draws before the Worker answers it.
 *
 * Pure: columns and a card in, a patch, the way back from it and the columns it now sits in
 * out. No React here, because this is the half that has to be provable. The board's two-drags
 * correctness lives in `withMoves` and in the `was` a move captures, and neither is something
 * a reader should have to hold in their head to be sure of.
 *
 * **The way back is the value the patch replaces, read off the card on screen** rather than
 * off the record when the write lands. By then the record is a write behind, and two quick
 * drags would each offer the same way back: one undo would take both moves off and the next
 * would do nothing. It is the discipline the tag picker and the checklist both keep, and
 * decision 20's.
 *
 * **A move's own fields go onto the card, not only its column.** A second drag reads the task
 * it is dragging off the list `withMoves` returns. A card one write behind would quietly
 * undo the write before it.
 */
import type { TaskWithBlocker } from "@vemi/shared";
import type { Column, Grouping } from "./boardGroups.js";
import { byPosition } from "./treeIndex.js";

/** A move the tree has not shown yet. Past a while, the tree is taken as right whatever it says. */
export interface Moved {
  /**
   * The grouping the move was made under. A move's columns mean nothing under another one,
   * so a move made by hand on the state board is not applied to the tag board and back.
   */
  readonly grouping: Grouping;
  /** The columns it now sits in. */
  readonly keys: readonly string[];
  /** What the move wrote, shown on the card until the tree carries it. */
  readonly fields: Partial<TaskWithBlocker>;
  readonly at: number;
}

/** Whether two column-key lists name the same columns, in whatever order. */
export const sameColumns = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((key) => b.includes(key));

/**
 * Columns with moves not yet answered applied, so a card lands where it was put rather than
 * jumping back until the Worker replies.
 */
export function withMoves(columns: readonly Column[], moved: ReadonlyMap<string, Moved>, grouping: Grouping): Column[] {
  const pending = new Map([...moved].filter(([, m]) => m.grouping === grouping));
  if (pending.size === 0) return [...columns];
  const tasks = new Map<string, TaskWithBlocker>();
  const home = new Map<string, string[]>();
  for (const c of columns) {
    for (const task of c.tasks) {
      const m = pending.get(task.id);
      tasks.set(task.id, m === undefined ? task : { ...task, ...m.fields });
      home.set(task.id, [...(home.get(task.id) ?? []), c.key]);
    }
  }
  const sits = (id: string): readonly string[] => pending.get(id)?.keys ?? home.get(id) ?? [];
  return columns.map((c) => ({
    ...c,
    tasks: [...tasks.values()].filter((t) => sits(t.id).includes(c.key)).sort(byPosition),
  }));
}

/** One drop across columns: what to write, what it replaces, and where the card ends up. */
export interface Move {
  readonly fields: Partial<TaskWithBlocker>;
  /** Every key `fields` overwrites, as the card on screen holds it. */
  readonly was: Partial<TaskWithBlocker>;
  /** The columns the card now sits in. */
  readonly keys: readonly string[];
  /** The column the card landed in, for the notice and the undo step. */
  readonly name: string;
}

/**
 * A drop across columns under the project grouping: `projectId` is what a move means there,
 * and the milestone with it, because a milestone belongs to a project. The none column's key
 * is `""`, and it takes `null`.
 */
export function moveAcross(
  task: TaskWithBlocker,
  to: string,
  columns: readonly Column[],
): Move {
  const nameOf = (key: string): string => columns.find((c) => c.key === key)?.name ?? key;
  return {
    fields: { projectId: to === "" ? null : to, milestoneId: null },
    was: { projectId: task.projectId, milestoneId: task.milestoneId },
    keys: [to],
    name: nameOf(to),
  };
}

/**
 * Where a card goes when the keyboard moves it one place up or down its column on the
 * state board: the id of the card it then sits before, null for the column's end, as
 * `place` reads a drop. Undefined when it is already at that end and there is nowhere to go.
 *
 * A step is over the cards on screen. A filter, or a project's page, can hide cards in
 * between, and a step past a hidden one would change nothing that can be seen — so moving
 * up lands before the shown card above, and moving down lands after the shown card below.
 * `all` is the whole column in order, `shown` the part of it drawn.
 */
export function stepInColumn(all: readonly string[], shown: readonly string[], id: string, by: -1 | 1): string | null | undefined {
  const at = shown.indexOf(id);
  if (at < 0) return undefined;
  const past = shown[at + by];
  if (past === undefined) return undefined;
  if (by === -1) return past;
  const rest = all.filter((other) => other !== id);
  return rest[rest.indexOf(past) + 1] ?? null;
}
