/**
 * The built-in search filters that need no date: a question each task answers alone. The
 * two that need today (due before it, due by the coming Sunday) are worked out by the Worker
 * (`GET /api/filters/dates`), so nothing here, and nothing in a client, compares a due date.
 * The tool picks nothing; each filter is a question about what exists.
 *
 * Done is a property of the task's state, which the task alone does not carry, so the
 * caller adds `finished` as the weekly review does. Archived tasks never count.
 */
import type { Task } from "./model.js";

/** A task with whether its state is finished. */
export type FilterTask = Task & { readonly finished: boolean };

export interface BuiltInFilter {
  readonly name: string;
  readonly test: (task: FilterTask) => boolean;
}

export const BUILT_IN_FILTERS: readonly BuiltInFilter[] = [
  { name: "Has a reminder", test: (t) => t.remindAt !== null },
  { name: "Repeating", test: (t) => t.repeat !== null },
  { name: "Done", test: (t) => t.finished },
];
