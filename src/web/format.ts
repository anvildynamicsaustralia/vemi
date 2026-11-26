/**
 * Dates and ages as the interface writes them. Nothing here compares a milestone's date
 * with today: a milestone is "aiming at" a day, and that is all it ever says.
 */
import type { DateOnly } from "@vemi/shared";

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

function parts(date: DateOnly): { y: number; m: number; d: number } | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (match === null) return null;
  return { y: Number(match[1]), m: Number(match[2]), d: Number(match[3]) };
}

/** `12 oct`, or `12 oct 2027` when it is not the year of `today`. */
export function shortDate(date: DateOnly, today: DateOnly | null = null): string {
  const p = parts(date);
  if (p === null) return date;
  const sameYear = today === null || parts(today)?.y === p.y;
  return `${p.d} ${MONTHS[p.m - 1] ?? ""}${sameYear ? "" : ` ${p.y}`}`;
}

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/** `24 September`, or `24 September 2027` when it is not the year of `today`. Add's summary. */
export function longDate(date: DateOnly, today: DateOnly | null = null): string {
  const p = parts(date);
  if (p === null) return date;
  const sameYear = today === null || parts(today)?.y === p.y;
  return `${p.d} ${MONTH_NAMES[p.m - 1] ?? ""}${sameYear ? "" : ` ${p.y}`}`;
}

/** `mon 14 sep`, the stamp at the top of today. */
export function dayStamp(date: DateOnly): string {
  const p = parts(date);
  if (p === null) return date;
  const weekday = new Date(Date.UTC(p.y, p.m - 1, p.d)).getUTCDay();
  return `${DAYS[weekday] ?? ""} ${p.d} ${MONTHS[p.m - 1] ?? ""}`;
}

const WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/**
 * `Thursday 24 September 2026`: a calendar's day as a screen reader says it. Every part of
 * it, because a day heard on its own has no grid around it to say which week or year it is.
 */
export function fullDate(date: DateOnly): string {
  const p = parts(date);
  if (p === null) return date;
  const weekday = new Date(Date.UTC(p.y, p.m - 1, p.d)).getUTCDay();
  return `${WEEKDAY_NAMES[weekday] ?? ""} ${p.d} ${MONTH_NAMES[p.m - 1] ?? ""} ${p.y}`;
}

/** How long ago an ISO time was, in the fewest words that stay true. */
export function age(iso: string, now: Date = new Date()): string {
  const seconds = Math.max(0, Math.round((now.getTime() - new Date(iso).getTime()) / 1000));
  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 36) return `${hours} h ago`;
  // Whole days only: thirty-six hours is a day ago, not two.
  const days = Math.floor(hours / 24);
  return days <= 1 ? "a day ago" : `${days} days ago`;
}

/** `VEMI`-style short label for a venture name in narrow places: its first word, uppercase. */
export function shortName(name: string): string {
  const first = name.trim().split(/\s+/)[0] ?? name;
  return first.length > 12 ? first.slice(0, 12) : first;
}
