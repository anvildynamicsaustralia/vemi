/**
 * Upcoming: what is due over the next two weeks, day by day, as a phone's scheduled list
 * shows it. Pure. Overdue (as the Worker marks it) comes first, as one group; then each day from today, every day
 * shown even when empty, so the week reads as a week and a day can be added to.
 */
import type { DateOnly } from "@vemi/shared";
import { addDays } from "./monthGrid.js";

export const UPCOMING_DAYS = 14;

export interface Dated {
  readonly id: string;
  readonly dueOn: DateOnly | null;
  readonly finished: boolean;
  readonly title: string;
}

export interface DayGroup<T> {
  /** The day, or null for the overdue group. */
  readonly on: DateOnly | null;
  readonly tasks: readonly T[];
}

export function upcomingGroups<T extends Dated>(
  tasks: readonly T[], today: DateOnly, late: ReadonlySet<string>, days = UPCOMING_DAYS,
): readonly DayGroup<T>[] {
  const open = tasks.filter((t) => !t.finished && t.dueOn !== null);
  const byTitle = (a: T, b: T): number => a.title.localeCompare(b.title);
  // What is late is the Worker's word (Today's answer marks it), never a date compared here.
  const overdue = open.filter((t) => late.has(t.id)).sort(byTitle);
  const out: DayGroup<T>[] = overdue.length > 0 ? [{ on: null, tasks: overdue }] : [];
  for (let i = 0; i < days; i++) {
    const on = addDays(today, i);
    out.push({ on, tasks: open.filter((t) => (on === t.dueOn && !late.has(t.id))).sort(byTitle) });
  }
  return out;
}

/** How many tasks the two weeks hold, overdue included. */
export const upcomingCount = <T>(groups: readonly DayGroup<T>[]): number => groups.reduce((n, g) => n + g.tasks.length, 0);
