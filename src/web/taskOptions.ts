import type { DateOnly, Task } from "@vemi/shared";
import { parseRepeat, weeklyOn } from "@vemi/shared";
import { addDays } from "./monthGrid.js";

/**
 * What each choice on a task's options sheet does: the patch it sends and the words that
 * name it in the undo notice. Pure, so the sheet is only buttons. The way back for any patch
 * is `undoPatch`: the same fields as the task holds them now.
 */

/** The fields the sheet can change. */
export type OptionsPatch = Partial<Pick<Task, "pickedOn" | "dueOn" | "remindAt" | "repeat">>;
export interface Choice { readonly patch: OptionsPatch; readonly label: string }

export type MoveKey = "today" | "tomorrow" | "week";
export type RemindKey = "off" | "9" | "12" | "17" | "pick";
export type RepeatKey = "never" | "daily" | "weekly" | "monthly";

/** The Monday after a date; a Monday's is a week on. */
export function nextMonday(date: DateOnly): DateOnly {
  const sunday0 = new Date(`${date}T00:00:00Z`).getUTCDay();
  const isoDay = sunday0 === 0 ? 7 : sunday0;
  return addDays(date, 8 - isoDay);
}

/** Today picks it for today. Tomorrow and next week date it and take it off today. */
export function moveChoice(key: MoveKey, on: DateOnly): Choice {
  if (key === "today") return { patch: { pickedOn: on }, label: "put on today" };
  if (key === "tomorrow") return { patch: { dueOn: addDays(on, 1), pickedOn: null }, label: "moved to tomorrow" };
  return { patch: { dueOn: nextMonday(on), pickedOn: null }, label: "moved to next week" };
}

/** The day a task's reminder and weekly repeat use: its due day, else its picked day, else today. */
function dayOf(task: Task, on: DateOnly): DateOnly {
  return task.dueOn ?? task.pickedOn ?? on;
}

const PRESET: Readonly<Record<"9" | "12" | "17", { readonly time: string; readonly words: string }>> = {
  "9": { time: "09:00", words: "9 am" },
  "12": { time: "12:00", words: "12 pm" },
  "17": { time: "17:00", words: "5 pm" },
};

function clock(time: string): string {
  const [h = 0, m = 0] = time.split(":").map(Number);
  const hour = h % 12 === 0 ? 12 : h % 12;
  return `${hour}:${String(m).padStart(2, "0")} ${h < 12 ? "am" : "pm"}`;
}

/** The reminder a choice sets, or null when "Pick a time" has no valid `HH:MM` yet. */
export function remindChoice(key: RemindKey, task: Task, on: DateOnly, picked: string | null): Choice | null {
  if (key === "off") return { patch: { remindAt: null }, label: "turned the reminder off" };
  if (key === "pick") {
    if (picked === null || !/^([01]\d|2[0-3]):[0-5]\d$/.test(picked)) return null;
    return { patch: { remindAt: `${dayOf(task, on)}T${picked}` }, label: `set a reminder for ${clock(picked)}` };
  }
  const p = PRESET[key];
  return { patch: { remindAt: `${dayOf(task, on)}T${p.time}` }, label: `set a reminder for ${p.words}` };
}

/** Weekly lands on the task's own weekday. */
export function repeatChoice(key: RepeatKey, task: Task, on: DateOnly): Choice {
  if (key === "never") return { patch: { repeat: null }, label: "stopped repeating" };
  if (key === "daily") return { patch: { repeat: "day" }, label: "set to repeat every day" };
  if (key === "monthly") return { patch: { repeat: "month" }, label: "set to repeat every month" };
  return { patch: { repeat: weeklyOn(dayOf(task, on)) }, label: "set to repeat every week" };
}

/** The patch that puts back what `patch` changes, null included. */
export function undoPatch(task: Task, patch: OptionsPatch): OptionsPatch {
  const back: Record<string, string | null> = {};
  for (const key of Object.keys(patch) as (keyof OptionsPatch)[]) back[key] = task[key];
  return back as OptionsPatch;
}

export function pressedMove(task: Task, on: DateOnly): MoveKey | null {
  if (task.pickedOn === on) return "today";
  if (task.pickedOn === null && task.dueOn === addDays(on, 1)) return "tomorrow";
  if (task.pickedOn === null && task.dueOn === nextMonday(on)) return "week";
  return null;
}

export function pressedRemind(task: Task): RemindKey {
  if (task.remindAt === null) return "off";
  const time = task.remindAt.slice(11);
  for (const key of ["9", "12", "17"] as const) if (PRESET[key].time === time) return key;
  return "pick";
}

export function pressedRepeat(task: Task): RepeatKey | null {
  const r = parseRepeat(task.repeat);
  if (r === null) return task.repeat === null ? "never" : null;
  if (r.kind === "day") return "daily";
  if (r.kind === "month") return "monthly";
  return r.kind === "week" ? "weekly" : null;
}
