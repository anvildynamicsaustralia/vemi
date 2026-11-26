/**
 * Quiet hours: a window of the day, in the person's own zone, when reminders are held
 * rather than sent. The window may span midnight (9 pm to 7 am). Times are `HH:MM` clock
 * strings as the account keeps them; the tick works in minutes since midnight.
 */

/** `HH:MM`, 00:00 to 23:59. */
export function isClock(v: unknown): v is string {
  return typeof v === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(v);
}

/** Minutes since midnight for an `HH:MM` clock, or null for anything else. */
export function clockMinutes(v: string | null): number | null {
  if (!isClock(v)) return null;
  return Number(v.slice(0, 2)) * 60 + Number(v.slice(3, 5));
}

/**
 * Whether this minute of the day falls inside the quiet window. The start is inside, the end
 * is not. With either end unset, or both the same, there is no window and nothing is quiet.
 */
export function inQuiet(minuteOfDay: number, from: string | null, to: string | null): boolean {
  const start = clockMinutes(from);
  const end = clockMinutes(to);
  if (start === null || end === null || start === end) return false;
  return start < end ? minuteOfDay >= start && minuteOfDay < end : minuteOfDay >= start || minuteOfDay < end;
}

/** The minute of the day the quiet window ends, or null when there is no window. */
export function quietEnd(from: string | null, to: string | null): number | null {
  const start = clockMinutes(from);
  const end = clockMinutes(to);
  if (start === null || end === null || start === end) return null;
  return end;
}
