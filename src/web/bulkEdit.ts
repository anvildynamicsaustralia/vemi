/**
 * A change made to several records at once, and the way back from it. Decision 9.
 *
 * The way back is per record, not per selection: moving six tasks into one state has six
 * different states to restore, and an undo that put them all where the first one came from
 * would be worse than no undo at all.
 *
 * Pure. The caller reads the records, this says what to write.
 */
import { ventureMove } from "./ventureMove.js";

export interface Patch {
  readonly id: string;
  readonly patch: Readonly<Record<string, unknown>>;
}

/** What `patch` is about to overwrite on each record, so that undo can put it back. */
export function revert<T extends { readonly id: string }>(
  items: readonly T[],
  patch: Readonly<Record<string, unknown>>,
): Patch[] {
  const keys = Object.keys(patch);
  return items.map((item) => {
    const was: Record<string, unknown> = {};
    for (const key of keys) was[key] = (item as unknown as Record<string, unknown>)[key] ?? null;
    return { id: item.id, patch: was };
  });
}

/** The same patch for every record, which is what a bulk change is. */
export function applyTo<T extends { readonly id: string }>(
  items: readonly T[],
  patch: Readonly<Record<string, unknown>>,
): Patch[] {
  return items.map((item) => ({ id: item.id, patch }));
}

/**
 * Only the records the change would actually change.
 *
 * Setting six tasks to the state four of them are already in should write two records and
 * offer to undo two, not six. A no-op selection writes nothing at all.
 */
export function changing<T extends { readonly id: string }>(
  items: readonly T[],
  patch: Readonly<Record<string, unknown>>,
): T[] {
  const keys = Object.keys(patch);
  return items.filter((item) => keys.some((key) => {
    const now = (item as unknown as Record<string, unknown>)[key] ?? null;
    return now !== (patch[key] ?? null);
  }));
}

/** "3 tasks" / "1 task", for the notice and the undo label. */
export function counted(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** A change over several records: what to write, and what puts each one back. */
export interface Change {
  readonly forward: readonly Patch[];
  readonly back: readonly Patch[];
}

/**
 * One tag put on, or taken off, every record that would change. A tag list travels whole, so
 * each record has its own list to write and its own to put back; a record already carrying
 * the tag (or already without it) is not written at all.
 */
export function tagChange<T extends { readonly id: string; readonly tagIds: readonly string[] }>(
  items: readonly T[],
  tagId: string,
  on: boolean,
): Change {
  const real = items.filter((item) => item.tagIds.includes(tagId) !== on);
  return {
    forward: real.map((item) => ({ id: item.id, patch: { tagIds: on ? [...item.tagIds, tagId] : item.tagIds.filter((t) => t !== tagId) } })),
    back: real.map((item) => ({ id: item.id, patch: { tagIds: [...item.tagIds] } })),
  };
}

/**
 * Tasks moved to another venture: each one the way a single task moves (`ventureMove.ts`),
 * so the bar and a task's own sheet write a move, and its way back, the same. A project and
 * a milestone are a venture's own, so neither survives the move, and the Worker gives each
 * task the new venture's state of the same kind. The way back names all four, so undo puts
 * back the project, the milestone and the state that the move let go of, not only the venture.
 */
export function ventureMoves<T extends { readonly id: string } & Parameters<typeof ventureMove>[0]>(items: readonly T[], ventureId: string): Change {
  const real = items.filter((item) => item.ventureId !== ventureId).map((item) => ({ id: item.id, ...ventureMove(item, ventureId) }));
  return {
    forward: real.map((m) => ({ id: m.id, patch: m.forward })),
    back: real.map((m) => ({ id: m.id, patch: m.back })),
  };
}
