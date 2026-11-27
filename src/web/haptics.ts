/**
 * A short buzz under the thumb as a thing happens, where the phone allows it. Android's
 * browsers do; iPhone's do not let a web page buzz at all, and there this does nothing.
 *
 * Three feels, kept few so they mean something: `tap` for a threshold crossed (a swipe far
 * enough, a pull far enough, a row picked up), `done` for a task finished, `remove` for a
 * thing archived. Never more than one at a time.
 */
export type Feel = "tap" | "done" | "remove";

export const PATTERNS: Record<Feel, number | readonly number[]> = {
  tap: 8,
  done: [10, 40, 14],
  remove: 18,
};

export function haptic(feel: Feel): void {
  try {
    if (typeof navigator === "undefined" || typeof navigator.vibrate !== "function") return;
    navigator.vibrate(PATTERNS[feel] as number | number[]);
  } catch {
    // A browser that refuses (no user gesture yet, or turned off) simply stays still.
  }
}
