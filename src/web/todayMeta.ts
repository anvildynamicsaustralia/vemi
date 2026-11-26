/**
 * The meta line under a task on Today, as parts in the mock's order: Overdue and its date,
 * where the task lives, how it repeats, when it reminds. Pure, so the row only draws it.
 */
import { repeatWord, type DateOnly, type TodayTask } from "@vemi/shared";
import { shortDate } from "./format.js";

export interface MetaPart {
  readonly kind: "overdue" | "where" | "repeat" | "reminder";
  readonly text: string;
}

/** `2026-11-17T09:00` as `9:00 am`, with the day first when it is not today. Null when unreadable. */
export function reminderWord(remindAt: string | null, on: DateOnly): string | null {
  const p = remindAt === null ? null : /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})$/.exec(remindAt);
  if (p === null) return null;
  const hour = Number(p[2]);
  const clock = `${hour % 12 === 0 ? 12 : hour % 12}:${p[3]} ${hour < 12 ? "am" : "pm"}`;
  return p[1] === on ? clock : `${shortDate(p[1] as DateOnly, on)} ${clock}`;
}

export function metaParts(task: TodayTask, where: string, on: DateOnly): MetaPart[] {
  const parts: MetaPart[] = [];
  if (task.overdue) parts.push({ kind: "overdue", text: task.dueOn === null ? "Overdue" : `Overdue · ${shortDate(task.dueOn, on)}` });
  if (where !== "") parts.push({ kind: "where", text: where });
  const repeat = repeatWord(task.repeat);
  if (repeat !== null) parts.push({ kind: "repeat", text: repeat });
  const reminder = reminderWord(task.remindAt, on);
  if (reminder !== null) parts.push({ kind: "reminder", text: reminder });
  return parts;
}
