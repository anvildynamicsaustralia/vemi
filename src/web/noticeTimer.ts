/**
 * How long the notice stays, and the pause that keeps it while a person is reading or
 * reaching for it. The timer stops while the pointer is over the notice or focus is inside
 * it, and starts again with exactly the time that was left, never a fresh full wait.
 * Pure, so the arithmetic is tested without a clock.
 */

/** Milliseconds a plain line stays, and a line carrying an action to reach. */
export const PLAIN_MS = 8000;
export const ACTION_MS = 12000;

export const stayFor = (hasAction: boolean): number => (hasAction ? ACTION_MS : PLAIN_MS);

/** `since` is when the clock last ran, or null while paused. */
export interface Countdown {
  readonly left: number;
  readonly since: number | null;
}

export const begin = (total: number, now: number): Countdown => ({ left: total, since: now });

/** What is left at `now`: the stored time less what has run since, never below zero. */
export const leftAt = (c: Countdown, now: number): number =>
  Math.max(0, c.since === null ? c.left : c.left - (now - c.since));

export const pause = (c: Countdown, now: number): Countdown =>
  c.since === null ? c : { left: leftAt(c, now), since: null };

export const resume = (c: Countdown, now: number): Countdown =>
  c.since === null ? { left: c.left, since: now } : c;

/** The notice holds still while either the pointer is over it or focus is inside it. */
export const holding = (over: boolean, focused: boolean): boolean => over || focused;
