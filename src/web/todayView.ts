/**
 * What the Today screen shows, worked out from the day's response and the tree. Pure: no
 * React, no fetching, so the screen and its sheets read one answer.
 *
 * Open tasks are ordered overdue first, then by `todayPosition`; a picked task that has no
 * position yet sorts after the positioned ones, in the order the API sent it (the sort is
 * stable). The tool never picks work: nothing here ranks by anything but what the person
 * placed.
 *
 * Coming up is `comingUp` narrowed to tasks, to the days after today up to a week ahead,
 * and to tasks not already picked.
 */
import type { DateOnly, Today, TodayTask, Tree } from "@vemi/shared";
import { comingUp, type Coming } from "./comingUp.js";
import { addDays } from "./monthGrid.js";

export interface TodayView {
  /** Picked tasks in a finished state. */
  readonly done: number;
  /** Picked tasks, plus overdue tasks that were not picked. */
  readonly total: number;
  readonly next: TodayTask | null;
  readonly also: readonly TodayTask[];
  readonly finished: readonly TodayTask[];
  readonly coming: readonly Coming[];
}

export type MoveKind = "today" | "tomorrow" | "nextWeek";

export interface MovePatch {
  readonly pickedOn: DateOnly | null;
  readonly dueOn?: DateOnly;
}

const isFinished = (t: TodayTask): boolean => t.stateKind === "finished";

export function todayView(today: Today, tree: Tree, on: DateOnly): TodayView {
  const finished = today.tasks.filter(isFinished);
  const open = today.tasks
    .filter((t) => !isFinished(t))
    .sort((a, b) => {
      if (a.overdue !== b.overdue) return a.overdue ? -1 : 1;
      if (a.todayPosition === b.todayPosition) return 0;
      if (a.todayPosition === null) return 1;
      if (b.todayPosition === null) return -1;
      return a.todayPosition - b.todayPosition;
    });

  const picked = new Set(today.tasks.filter((t) => t.picked).map((t) => t.id));
  const last = addDays(on, 7);
  const coming = comingUp(tree, today)
    .filter((c) => c.kind === "task" && !picked.has(c.id) && c.date > on && c.date <= last)
    // Array sort is stable, so same-day tasks keep the tree's order.
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  return {
    done: today.tasks.filter((t) => t.picked && isFinished(t)).length,
    total: today.tasks.filter((t) => t.picked || t.overdue).length,
    next: open[0] ?? null,
    also: open.slice(1),
    finished,
    coming,
  };
}

/** The position that sends a task to the end of today's list. */
export function laterPosition(today: Today): number {
  let top = 0;
  for (const t of today.tasks) if (t.todayPosition !== null && t.todayPosition > top) top = t.todayPosition;
  return top + 1;
}

export interface LaterStep {
  readonly id: string;
  readonly from: number | null;
  readonly to: number;
}

/**
 * The position changes that send one task to the end of today's order. Open tasks that have
 * no position yet are given one first, in the order they are shown, so the moved task lands
 * after them and not beside them; then the task itself takes the last place.
 */
export function laterPlan(today: Today, view: TodayView, id: string): readonly LaterStep[] {
  const open = [...(view.next === null ? [] : [view.next]), ...view.also];
  const target = open.find((t) => t.id === id);
  if (target === undefined) return [];
  let next = laterPosition(today);
  const steps: LaterStep[] = [];
  for (const t of open) if (t.id !== id && t.todayPosition === null) steps.push({ id: t.id, from: null, to: next++ });
  steps.push({ id, from: target.todayPosition, to: next });
  return steps;
}

/** The Monday after a date: the next day from a Sunday, a full week on from a Monday. */
function nextMonday(date: DateOnly): DateOnly {
  const p = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (p === null) return date;
  const weekday = new Date(Date.UTC(Number(p[1]), Number(p[2]) - 1, Number(p[3]))).getUTCDay();
  return addDays(date, (8 - weekday) % 7 || 7);
}

/**
 * The patch for Move to. Today picks the task. Tomorrow and Next week give it a due date and
 * clear the pick, so it leaves today's list and shows up in Coming up when its day nears.
 */
export function moveTo(kind: MoveKind, on: DateOnly): MovePatch {
  switch (kind) {
    case "today": return { pickedOn: on };
    case "tomorrow": return { dueOn: addDays(on, 1), pickedOn: null };
    case "nextWeek": return { dueOn: nextMonday(on), pickedOn: null };
  }
}
