/**
 * Pull to refresh, as facts. Pure. A finger pulled down from the very top of the page moves
 * the indicator with resistance; past `PULL_AT` it is far enough, and letting go then reads
 * everything on screen again.
 */
export const PULL_AT = 72;
export const PULL_MAX = 110;

/** How far the indicator has come for a finger this far down: half, then less past the mark. */
export function pulled(dy: number): number {
  if (dy <= 0) return 0;
  const half = dy * 0.5;
  return half <= PULL_AT ? half : Math.min(PULL_MAX, PULL_AT + (half - PULL_AT) * 0.35);
}

/** Letting go here refreshes. */
export const ready = (dy: number): boolean => pulled(dy) >= PULL_AT;
