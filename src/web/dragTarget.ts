/**
 * Where a dragged row has got to. Pure: rectangles in, an index out.
 *
 * Decision 8 replaces the arrow buttons with drag, and design-review-v2 asks that the rows
 * which have to get out of the way slide, so the gap opens and closes under your hand.
 * Nothing here moves anything. It answers two questions — which index the row is over now,
 * and how far each other row has to shift to show it — and the hook does the rest.
 *
 * Only ever transforms: the flow is never touched, so a list of rows of different heights
 * (Today's are, a venture's projects are not) needs no special case. The measurements are
 * taken once, when the drag starts, for the same reason.
 */

export interface Row {
  readonly id: string;
  /** Viewport top at the moment the drag began. */
  readonly top: number;
  readonly height: number;
}

const centre = (r: Row): number => r.top + r.height / 2;

/**
 * The index `from` has been dragged to, given how far it has moved.
 *
 * Which slot the dragged row's centre has landed in, where the slots are where the rows
 * sat when the drag began. Comparing centre against centre instead would mean dragging a
 * whole row's height before anything swapped, because the row being passed has not moved
 * out of the way yet at the moment of the test. This way the swap happens at half a row,
 * which is where the hand expects it.
 */
export function targetIndex(rows: readonly Row[], from: number, dy: number): number {
  const moving = rows[from];
  if (moving === undefined) return from;
  const now = centre(moving) + dy;
  for (const [i, row] of rows.entries()) {
    if (now < row.top + row.height) return i;
  }
  return Math.max(0, rows.length - 1);
}

/**
 * How far row `i` shifts while `from` is being held over `to`, in pixels.
 *
 * Every row the dragged one has passed moves by exactly the dragged row's height, in the
 * opposite direction. Rows outside the span do not move at all.
 */
export function shiftFor(rows: readonly Row[], from: number, to: number, i: number): number {
  const h = rows[from]?.height ?? 0;
  if (i === from || h === 0 || from === to) return 0;
  if (from < to) return i > from && i <= to ? -h : 0;
  return i >= to && i < from ? h : 0;
}

/** Where the dragged row itself is drawn: under the pointer, but never outside the list. */
export function liftBy(rows: readonly Row[], from: number, dy: number): number {
  const moving = rows[from];
  const first = rows[0];
  const last = rows.at(-1);
  if (moving === undefined || first === undefined || last === undefined) return dy;
  const lowest = first.top - moving.top;
  const highest = last.top + last.height - (moving.top + moving.height);
  return Math.max(lowest, Math.min(highest, dy));
}
