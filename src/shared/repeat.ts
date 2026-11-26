import type { DateOnly } from "./model.js";

/**
 * How a task repeats, stored as one short text on the task: `day`, `weekday`, `month` or
 * `week:N`, where N runs 1 to 7 and Monday is 1. The text is the contract between the API,
 * the options sheet and the capture phase, so the grammar lives here and nowhere else.
 */
export type Repeat =
  | { readonly kind: "day" }
  | { readonly kind: "weekday" }
  | { readonly kind: "month" }
  | { readonly kind: "week"; readonly day: 1 | 2 | 3 | 4 | 5 | 6 | 7 };

const DAY_NAMES = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"] as const;

/** The repeat a text names, or null when it is not in the grammar. Exact, no trimming. */
export function parseRepeat(text: unknown): Repeat | null {
  if (text === "day" || text === "weekday" || text === "month") return { kind: text };
  if (typeof text !== "string") return null;
  const m = /^week:([1-7])$/.exec(text);
  return m === null ? null : { kind: "week", day: Number(m[1]) as 1 | 2 | 3 | 4 | 5 | 6 | 7 };
}

/** What a stored repeat says on screen, or null for no repeat or text outside the grammar. */
export function repeatWord(text: string | null): string | null {
  const r = parseRepeat(text);
  if (r === null) return null;
  if (r.kind === "day") return "Every day";
  if (r.kind === "weekday") return "Every weekday";
  if (r.kind === "month") return "Every month";
  return `Every ${DAY_NAMES[r.day - 1]}`;
}

/** The weekly repeat that lands on this date's own weekday. */
export function weeklyOn(date: DateOnly): string {
  const sunday0 = new Date(`${date}T00:00:00Z`).getUTCDay();
  return `week:${sunday0 === 0 ? 7 : sunday0}`;
}
