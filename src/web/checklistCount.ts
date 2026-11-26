/**
 * How far down a checklist something is. Pure.
 *
 * A module rather than a line of JSX because two surfaces print the same figure: the
 * detail sheet beside the Checklist kicker, and the card on the board. "3 of 7" said two
 * different ways in two places is how two places start disagreeing, and a checklist is
 * carried whole on the task, so both already hold everything the count needs.
 *
 * A list with nothing in it says nothing at all. A task with no checklist is the ordinary
 * case, and "0 of 0" beside its title would be a figure about a thing that is not there.
 */
import type { ChecklistItem } from "@vemi/shared";

export interface ChecklistCount {
  /** How many are ticked. */
  readonly done: number;
  /** How many there are. */
  readonly of: number;
  /** What a surface prints: "3 of 7", or nothing at all for an empty list. */
  readonly said: string;
}

export function checklistCount(items: readonly ChecklistItem[]): ChecklistCount {
  let done = 0;
  for (const item of items) if (item.done) done++;
  return { done, of: items.length, said: items.length === 0 ? "" : `${done} of ${items.length}` };
}
