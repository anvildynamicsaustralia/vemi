import type { Today } from "@vemi/shared";

export interface TodayCounts {
  readonly on: number;
  readonly overdue: number;
}

/**
 * What the Today list holds, as two numbers: the tasks picked for the day, and the overdue
 * ones that were not picked. The same two filters `ui/Today.tsx` draws its lists from, so a
 * count and the list under it never disagree. No React here: the Today phase reuses it.
 */
export function todayCounts(today: Today): TodayCounts {
  return {
    on: today.tasks.filter((t) => t.picked).length,
    overdue: today.tasks.filter((t) => t.overdue && !t.picked).length,
  };
}
