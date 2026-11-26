/**
 * The weekly review reads. Pure: tasks and a day in, three lists out. The tool picks
 * nothing; these are what the person looks at, and every list is a view of what exists.
 *
 * A week is 7 calendar days counting today, so back is `today - 6` to `today` and ahead
 * is `today` to `today + 6`. Two reviews a week apart leave no gap and no overlap.
 * Dates in `updatedAt` are read as the UTC day of the stamp.
 */
import type { DateOnly, Task } from "./model.js";

/** A task with the one thing the module cannot read from it: whether its state is finished. */
export type ReviewTask = Task & { readonly finished: boolean };

export interface Review {
  /** Finished in the last 7 days, newest first. */
  readonly lookBack: readonly ReviewTask[];
  /** Due before today by an explicit date (oldest date first), then untouched for 30 days. Each once. */
  readonly clearUp: readonly ReviewTask[];
  /** Unfinished and due in the next 7 days, by date. */
  readonly lookAhead: readonly ReviewTask[];
}

const DAY_MS = 86_400_000;
const WEEK = 7;
const STALE_DAYS = 30;

function shift(date: DateOnly, days: number): DateOnly {
  const p = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (p === null) return date;
  const at = Date.UTC(Number(p[1]), Number(p[2]) - 1, Number(p[3])) + days * DAY_MS;
  return new Date(at).toISOString().slice(0, 10);
}

function dayOf(stamp: string): DateOnly {
  return stamp.slice(0, 10);
}

function dueBefore(t: ReviewTask, today: DateOnly): boolean {
  return t.dueOn !== null && t.dueOn < today;
}

/** The three weekly review lists for `today`. Archived tasks are in none of them. */
export function reviewOf(tasks: readonly ReviewTask[], today: DateOnly): Review {
  const live = tasks.filter((t) => t.archivedAt === null);
  const backFrom = shift(today, -(WEEK - 1));
  const aheadTo = shift(today, WEEK - 1);
  const staleBy = shift(today, -STALE_DAYS);

  const lookBack = live
    .filter((t) => t.finished && dayOf(t.updatedAt) >= backFrom && dayOf(t.updatedAt) <= today)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

  const open = live.filter((t) => !t.finished);
  const late = open
    .filter((t) => dueBefore(t, today))
    .sort((a, b) => (a.dueOn as string).localeCompare(b.dueOn as string) || a.updatedAt.localeCompare(b.updatedAt));
  const untouched = open
    .filter((t) => !dueBefore(t, today) && dayOf(t.updatedAt) <= staleBy)
    .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));

  const lookAhead = open
    .filter((t) => t.dueOn !== null && t.dueOn >= today && t.dueOn <= aheadTo)
    .sort((a, b) => (a.dueOn as string).localeCompare(b.dueOn as string));

  return { lookBack, clearUp: [...late, ...untouched], lookAhead };
}
