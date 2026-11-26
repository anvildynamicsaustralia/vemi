/**
 * The one way a reminder reaches the screen. The reminders phase decides when a reminder is
 * due and calls `showReminder`; it does nothing else here. The banner in the shell listens.
 * They share a window event and nothing more, so neither imports the other.
 *
 * `at` is the reminder's own wall time, `YYYY-MM-DDTHH:MM` with no zone, the same shape as a
 * task's `remindAt`. Snoozing adds an hour to it by calendar arithmetic on those digits, not
 * by the device clock, so a reminder set for 11:30 pm snoozes into the next day correctly.
 */

export const REMINDER_EVENT = "vemi:reminder";

export interface Reminder {
  readonly taskId: string;
  readonly at: string;
}

const WALL = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;

export function showReminder(reminder: Reminder): void {
  const target = globalThis.window;
  if (target === undefined) return;
  target.dispatchEvent(new CustomEvent<Reminder>(REMINDER_EVENT, { detail: { taskId: reminder.taskId, at: reminder.at } }));
}

/** Listen for reminders. Answers the way to stop listening. */
export function onReminder(handler: (reminder: Reminder) => void): () => void {
  const target = globalThis.window;
  if (target === undefined) return () => undefined;
  const listener = (event: Event): void => handler((event as CustomEvent<Reminder>).detail);
  target.addEventListener(REMINDER_EVENT, listener);
  return () => target.removeEventListener(REMINDER_EVENT, listener);
}

/** The wall time an hour on from `at`; `at` itself when it is not a wall time. */
export function inOneHour(at: string): string {
  const m = WALL.exec(at);
  if (m === null) return at;
  const [, y, mo, d, h, mi] = m;
  const next = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h) + 1, Number(mi)));
  return next.toISOString().slice(0, 16);
}

/** What "In 1 hour" writes to the task. */
export function snoozePatch(at: string): { readonly remindAt: string } {
  return { remindAt: inOneHour(at) };
}

/** The clock part of a wall time, as the banner says it: "2:00 pm". */
export function clockOf(at: string): string {
  const m = WALL.exec(at);
  if (m === null) return "";
  const hour = Number(m[4]);
  const twelve = hour % 12 === 0 ? 12 : hour % 12;
  return `${twelve}:${m[5]} ${hour < 12 ? "am" : "pm"}`;
}
