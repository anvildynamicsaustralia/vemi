/**
 * The reminders of a copy that lives in the page: the minute's check, with no push service.
 *
 * The due rule is the Worker's own, not a copy of it: the store's `dueReminders` finds the
 * tasks (never an archived or a finished one, each once per `remindAt`), and `reminders.ts`
 * says what time it is in the account's zone and when it is quiet. What differs is where the
 * answer goes: `show` is the page's `showReminder`, not a message to a device.
 *
 * A reminder is let go after its window, the same day the Worker lets one go. A page hidden
 * for longer than the window shows nothing on the tick, so a laptop opened after a week does
 * not read out a week of reminders.
 */
import type { Store } from "../api/store.js";
import { isQuiet, localClock, wallMinus } from "../api/reminders.js";
import type { Reminder } from "../web/reminderEvent.js";

/** The same day the Worker looks back over. */
export const REMINDER_WINDOW_MINUTES = 24 * 60;

/** The most one tick shows, as the store's own bound. */
const MOST = 200;

export interface LocalTickOptions {
  readonly store: Store;
  readonly owner: string;
  readonly now: Date;
  /** The account's zone when it has not set its own. */
  readonly timeZone: string;
  /** `showReminder`. */
  readonly show: (reminder: Reminder) => void;
  /** When the page went out of view, if it is out of view now. */
  readonly hiddenSince?: Date | null;
  readonly windowMinutes?: number;
}

/** Shows what is due now. Answers how many it showed. */
export async function localTick(options: LocalTickOptions): Promise<number> {
  const { store, owner, now } = options;
  const window = options.windowMinutes ?? REMINDER_WINDOW_MINUTES;
  if (options.hiddenSince != null && (now.getTime() - options.hiddenSince.getTime()) / 60_000 > window) return 0;

  const settings = await store.appearance(owner);
  if (!settings.taskReminders) return 0;
  const local = localClock(now, settings.timeZone ?? options.timeZone, options.timeZone);
  if (isQuiet(local.time, settings.quietFrom, settings.quietTo)) return 0;

  const wall = `${local.date}T${local.time}`;
  const due = await store.dueReminders(owner, wallMinus(wall, window), wall, MOST);
  for (const item of due) {
    options.show({ taskId: item.taskId, at: item.remindAt });
    await store.recordReminderSent(owner, "task", item.taskId, item.remindAt);
  }
  return due.length;
}
