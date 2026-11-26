import type { DateOnly } from "./model.js";
import { weeklyOn } from "./repeat.js";

/**
 * Smart dates: reads a date, a repeat and a time out of the words someone types as a title.
 * Pure: it takes the clock and the zone as arguments and returns what it found, with the
 * words it removed so a screen can show them as chips and give them back.
 */

/** One piece of the text that was understood. `words` is exactly what was typed. */
export interface SmartToken {
  readonly words: string;
  readonly kind: "date" | "repeat" | "time";
}

/** The result of reading a title. `title` is the text with the understood words removed. */
export interface SmartParse {
  readonly title: string;
  /** A due date, or null. */
  readonly when: DateOnly | null;
  /** A `repeat.ts` value (`day`, `weekday`, `month`, `week:N`), or null. */
  readonly repeat: string | null;
  /** Local `YYYY-MM-DDTHH:MM`, or null. */
  readonly remindAt: string | null;
  readonly tokens: readonly SmartToken[];
}

const DAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];
const DAY_PATTERN = DAYS.join("|");
const EDGE = String.raw`(?<![\p{L}\p{N}_-])`;
const END = String.raw`(?![\p{L}\p{N}_-])`;

const REPEAT_RE = new RegExp(`${EDGE}every\\s+(day|weekday|week|month|${DAY_PATTERN})${END}`, "giu");
const DATE_RE = new RegExp(`${EDGE}(tomorrow|today|next\\s+week|(?:next\\s+)?(?:${DAY_PATTERN}))${END}`, "giu");
const TIME_RE = new RegExp(`${EDGE}at\\s+(\\d{1,2})(?::(\\d{2}))?(?:\\s*(am|pm))?${END}`, "giu");

interface Hit {
  readonly start: number;
  readonly end: number;
  readonly kind: SmartToken["kind"];
  readonly match: RegExpExecArray;
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function addDays(date: DateOnly, days: number): DateOnly {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** Monday 1 to Sunday 7. */
function isoDay(date: DateOnly): number {
  const d = new Date(`${date}T00:00:00Z`).getUTCDay();
  return d === 0 ? 7 : d;
}

/** The calendar date and minutes into the day, in a zone. */
function localNow(now: Date, timeZone: string): { date: DateOnly; minutes: number } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(now);
  const get = (type: string): string => parts.find((x) => x.type === type)?.value ?? "0";
  return {
    date: `${get("year")}-${get("month")}-${get("day")}`,
    minutes: Number(get("hour")) * 60 + Number(get("minute")),
  };
}

/** The date a date word names. A weekday is the next one, never today. */
function dateFor(word: string, today: DateOnly): DateOnly {
  const w = word.toLowerCase().replace(/\s+/g, " ");
  if (w === "today") return today;
  if (w === "tomorrow") return addDays(today, 1);
  const here = isoDay(today);
  if (w === "next week") return addDays(today, 8 - here);
  const target = DAYS.indexOf(w.replace(/^next /, "")) + 1;
  return addDays(today, ((target - here + 6) % 7) + 1);
}

/** Minutes into the day for the hour, minute and suffix typed, or null when not a real time. */
function minutesFor(hourText: string, minuteText: string | undefined, suffix: string | undefined): number | null {
  let hour = Number(hourText);
  const minute = minuteText === undefined ? 0 : Number(minuteText);
  if (minute > 59) return null;
  if (suffix !== undefined) {
    if (hour < 1 || hour > 12) return null;
    hour = (hour % 12) + (suffix.toLowerCase() === "pm" ? 12 : 0);
  } else {
    if (hour > 23) return null;
    if (hour >= 1 && hour <= 7) hour += 12;
  }
  return hour * 60 + minute;
}

function hits(text: string, re: RegExp, kind: Hit["kind"]): Hit[] {
  return [...text.matchAll(re)].map((match) => ({
    start: match.index, end: match.index + match[0].length, kind, match: match as RegExpExecArray,
  }));
}

/**
 * Reads `text` as of `now` in `timeZone`. The first date, repeat and time found are used and
 * their words removed; anything else stays in the title. Words inside "every monday" are a
 * repeat, never also a date, and a repeat sets no date. A time with no date is today, or
 * tomorrow once it has passed. Text with nothing understood, or where nothing would be left
 * as a title, comes back as it was.
 */
export function parse(text: string, now: Date, timeZone: string): SmartParse {
  const none: SmartParse = { title: text, when: null, repeat: null, remindAt: null, tokens: [] };
  const here = localNow(now, timeZone);

  const picked: Hit[] = [];
  const take = (list: Hit[]): Hit | undefined => {
    const h = list.find((c) => !picked.some((p) => c.start < p.end && p.start < c.end));
    if (h !== undefined) picked.push(h);
    return h;
  };

  const repeatHit = take(hits(text, REPEAT_RE, "repeat"));
  const dateHit = take(hits(text, DATE_RE, "date"));
  const timeHit = take(
    hits(text, TIME_RE, "time").filter((h) => minutesFor(h.match[1] ?? "", h.match[2], h.match[3]) !== null),
  );
  if (picked.length === 0) return none;

  const title = picked
    .slice()
    .sort((a, b) => b.start - a.start)
    .reduce((rest, h) => `${rest.slice(0, h.start)} ${rest.slice(h.end)}`, text)
    .replace(/\s+/g, " ")
    .trim();
  if (title === "") return none;

  let repeat: string | null = null;
  if (repeatHit !== undefined) {
    const unit = (repeatHit.match[1] ?? "").toLowerCase();
    const day = DAYS.indexOf(unit);
    repeat = unit === "week" ? weeklyOn(here.date) : day >= 0 ? `week:${day + 1}` : unit;
  }

  const when = dateHit === undefined ? null : dateFor(dateHit.match[1] ?? "", here.date);

  let remindAt: string | null = null;
  if (timeHit !== undefined) {
    const minutes = minutesFor(timeHit.match[1] ?? "", timeHit.match[2], timeHit.match[3]) ?? 0;
    const on = when ?? (minutes <= here.minutes ? addDays(here.date, 1) : here.date);
    remindAt = `${on}T${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;
  }

  const tokens = picked
    .slice()
    .sort((a, b) => a.start - b.start)
    .map((h) => ({ words: h.match[0], kind: h.kind }));
  return { title, when, repeat, remindAt, tokens };
}
