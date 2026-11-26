import type { DateOnly } from "./model.js";
import type { Repeat } from "./repeat.js";

/**
 * When a repeating task next falls due. Works on calendar dates only, so a daylight-saving
 * day is an ordinary day. The answer is always strictly after both the old due date and
 * today, so finishing a task late never files the next one in the past.
 */

const DAY_MS = 86_400_000;

function ms(date: DateOnly): number {
  return Date.parse(`${date}T00:00:00Z`);
}

function text(at: number): DateOnly {
  return new Date(at).toISOString().slice(0, 10);
}

/** Monday 1 to Sunday 7. */
function isoWeekday(date: DateOnly): number {
  const d = new Date(ms(date)).getUTCDay();
  return d === 0 ? 7 : d;
}

/** The same day of a month `by` months on, or that month's last day when it is shorter. */
function monthsOn(date: DateOnly, by: number): DateOnly {
  const at = new Date(ms(date));
  const year = at.getUTCFullYear();
  const month = at.getUTCMonth() + by;
  const last = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return text(Date.UTC(year, month, Math.min(at.getUTCDate(), last)));
}

/** The next date the rule gives after `from`, and strictly after `today` too. */
export function nextDue(repeat: Repeat, from: DateOnly, today: DateOnly): DateOnly {
  const after = from > today ? from : today;
  if (repeat.kind === "month") {
    let by = 1;
    let next = monthsOn(from, by);
    while (next <= after) next = monthsOn(from, ++by);
    return next;
  }
  let at = ms(after) + DAY_MS;
  for (;;) {
    const date = text(at);
    const day = isoWeekday(date);
    if (repeat.kind === "day") return date;
    if (repeat.kind === "weekday" ? day <= 5 : day === repeat.day) return date;
    at += DAY_MS;
  }
}
