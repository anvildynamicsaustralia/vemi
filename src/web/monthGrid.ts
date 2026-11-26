/**
 * A month as a calendar draws it. Pure: a year and a month in, weeks of days out.
 *
 * Decision 14: dates are set by tapping a small calendar. The native date input was the
 * last place in the interface where the browser, not the design, decided what a control
 * looked like — and on a phone it opens a wheel that needs three scrolls to say "next week".
 *
 * Everything is worked out in UTC. These are dates, not moments: local-time arithmetic
 * repeats or skips a day in the week a clock changes, and a calendar that draws the 5th
 * twice is worse than no calendar.
 */

import { chorded, type Press } from "./rove.js";

export interface DayCell {
  /** `YYYY-MM-DD`. */
  readonly date: string;
  readonly day: number;
  /** False for the days of the months either side that fill out the first and last weeks. */
  readonly inMonth: boolean;
}

export interface Month {
  readonly year: number;
  /** 1 to 12. */
  readonly month: number;
}

const DAY_MS = 86_400_000;
const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/** Monday first, as the week is written here. */
export const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;

const iso = (at: number): string => new Date(at).toISOString().slice(0, 10);

/** Whole weeks, Monday first, covering every day of the month. */
export function monthGrid(year: number, month: number): DayCell[][] {
  const first = Date.UTC(year, month - 1, 1);
  const days = new Date(Date.UTC(year, month, 0)).getUTCDate();
  // getUTCDay is Sunday 0. Monday first, so Monday is 0 and Sunday is 6.
  const lead = (new Date(first).getUTCDay() + 6) % 7;
  const cells = Math.ceil((lead + days) / 7) * 7;
  const weeks: DayCell[][] = [];
  for (let i = 0; i < cells; i++) {
    const at = first + (i - lead) * DAY_MS;
    const when = new Date(at);
    const cell: DayCell = { date: iso(at), day: when.getUTCDate(), inMonth: when.getUTCMonth() === month - 1 };
    if (i % 7 === 0) weeks.push([]);
    weeks[weeks.length - 1]?.push(cell);
  }
  return weeks;
}

export function shiftMonth(from: Month, by: number): Month {
  const at = new Date(Date.UTC(from.year, from.month - 1 + by, 1));
  return { year: at.getUTCFullYear(), month: at.getUTCMonth() + 1 };
}

export function addDays(date: string, days: number): string {
  const p = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (p === null) return date;
  return iso(Date.UTC(Number(p[1]), Number(p[2]) - 1, Number(p[3])) + days * DAY_MS);
}

/** The same day of another month, or that month's last day when it is shorter. */
export function addMonths(date: string, months: number): string {
  const p = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (p === null) return date;
  const to = shiftMonth({ year: Number(p[1]), month: Number(p[2]) }, months);
  const last = new Date(Date.UTC(to.year, to.month, 0)).getUTCDate();
  return iso(Date.UTC(to.year, to.month - 1, Math.min(Number(p[3]), last)));
}

/**
 * Where a key moves a calendar's focused day: a day either side, a week up or down, a month
 * with Page Up and Page Down. Null for any other key, and for one held with Alt, Ctrl or Cmd
 * (`chorded`). The grid is seven across, so up and down are a week whichever month the day
 * lands in.
 */
export function dayStep(date: string, press: Press): string | null {
  if (chorded(press)) return null;
  switch (press.key) {
    case "ArrowLeft": return addDays(date, -1);
    case "ArrowRight": return addDays(date, 1);
    case "ArrowUp": return addDays(date, -7);
    case "ArrowDown": return addDays(date, 7);
    case "PageUp": return addMonths(date, -1);
    case "PageDown": return addMonths(date, 1);
    default: return null;
  }
}

/**
 * The Sunday that ends the week a date is in, the date itself when it is a Sunday. Add's
 * "This week" is a due date on it: the week is written Monday first, so it ends on Sunday.
 */
export function weekEnd(date: string): string {
  const p = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (p === null) return date;
  const weekday = new Date(Date.UTC(Number(p[1]), Number(p[2]) - 1, Number(p[3]))).getUTCDay();
  return addDays(date, (7 - weekday) % 7);
}

/** The month a date sits in, or null when it is not a date. */
export function monthOf(date: string): Month | null {
  const p = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  return p === null ? null : { year: Number(p[1]), month: Number(p[2]) };
}

export function monthTitle(month: Month): string {
  return `${MONTH_NAMES[month.month - 1] ?? ""} ${month.year}`;
}

/** Today as this device sees it. The calendar marks it; nothing is compared with it. */
export function localToday(now: Date = new Date()): string {
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}
