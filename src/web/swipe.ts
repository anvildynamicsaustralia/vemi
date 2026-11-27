/**
 * Swiping a row sideways, as a phone's lists do: the decisions, as facts. Pure.
 *
 * A press that travels sideways first is a swipe and the row follows the finger; one that
 * travels up or down first is the page scrolling, and the row leaves it alone. On release a
 * swipe to the right far enough runs the row's leading action (Done); a swipe to the left
 * far enough leaves the trailing buttons showing; anything shorter springs back.
 */

/** How far a finger travels before the gesture is read as a swipe or a scroll. */
export const SWIPE_SLOP = 10;

/** A leading swipe runs its action past this share of the row's width, or this many pixels. */
export const LEAD_SHARE = 0.35;
export const LEAD_MIN = 96;

/** A trailing swipe opens the buttons past this many pixels. */
export const TRAIL_OPEN = 56;

export type Axis = "swipe" | "scroll" | null;

/** Which way the gesture went, once it has gone far enough to say; null until then. */
export function axisOf(dx: number, dy: number): Axis {
  if (Math.abs(dx) < SWIPE_SLOP && Math.abs(dy) < SWIPE_SLOP) return null;
  return Math.abs(dx) > Math.abs(dy) * 1.2 ? "swipe" : "scroll";
}

/**
 * Where the row sits under the finger: free to the right as far as there is a leading action,
 * to the left a little past the trailing buttons, with a resistance beyond them.
 */
export function followed(dx: number, lead: boolean, trailWidth: number, width: number): number {
  if (dx > 0) return lead ? Math.min(dx, width) : 0;
  if (trailWidth === 0) return 0;
  const past = -dx - trailWidth;
  return past <= 0 ? dx : -(trailWidth + past * 0.3);
}

export type Release = "lead" | "open" | "close";

/** What a lifted finger does. `open` says whether the trailing buttons were already showing. */
export function releaseOf(dx: number, width: number, lead: boolean, trailWidth: number, open = false): Release {
  if (lead && dx >= Math.max(LEAD_MIN, width * LEAD_SHARE)) return "lead";
  if (trailWidth > 0 && (open ? dx < TRAIL_OPEN / 2 : -dx >= TRAIL_OPEN)) return "open";
  return "close";
}
