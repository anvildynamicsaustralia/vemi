/**
 * Manual order. "Order is manual. The tool never picks work for you." Pure: a list in the
 * order it is shown, and the positions that put something somewhere else in it.
 *
 * Positions are real numbers, so a move usually writes one record: the moved one, halfway
 * between its new neighbours. Only when there is no room between them (two records created
 * with the same position, or a gap halved until it is gone) is the whole list numbered again,
 * and then only the records whose number changes are written.
 */

export interface Placed {
  readonly id: string;
  readonly position: number;
  readonly createdAt: string;
}

export interface Placement {
  readonly id: string;
  readonly position: number;
}

/**
 * Put `movingId` at index `to` of `rest`, a list in shown order that does not contain it.
 * Always includes the moving record's placement.
 */
export function place(rest: readonly Placed[], movingId: string, to: number): Placement[] {
  const at = Math.max(0, Math.min(rest.length, to));
  const before = rest[at - 1]?.position;
  const after = rest[at]?.position;
  const position = before === undefined && after === undefined ? 1
    : before === undefined ? (after as number) - 1
    : after === undefined ? before + 1
    : (before + after) / 2;
  const fits = (before === undefined || position > before) && (after === undefined || position < after);
  if (fits) return [{ id: movingId, position }];

  // No room: number everything again, 1, 2, 3, in the new order.
  const ids = [...rest.slice(0, at).map((r) => r.id), movingId, ...rest.slice(at).map((r) => r.id)];
  const was = new Map(rest.map((r) => [r.id, r.position]));
  return ids
    .map((id, i) => ({ id, position: i + 1 }))
    .filter((p) => p.id === movingId || was.get(p.id) !== p.position);
}

/** Move a record already in `items` to index `to` of the list without it. `[]` when nothing moves. */
export function reorder(items: readonly Placed[], id: string, to: number): Placement[] {
  const from = items.findIndex((i) => i.id === id);
  if (from < 0) return [];
  const rest = items.filter((i) => i.id !== id);
  const at = Math.max(0, Math.min(rest.length, to));
  if (at === from) return [];
  return place(rest, id, at);
}

/** One step up (-1) or down (+1). */
export function step(items: readonly Placed[], id: string, by: -1 | 1): Placement[] {
  const from = items.findIndex((i) => i.id === id);
  return from < 0 ? [] : reorder(items, id, from + by);
}
