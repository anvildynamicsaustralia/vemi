/**
 * A task's steps as the sheet holds them: each with an id of its own. Pure.
 *
 * A step is stored as its text and whether it is done, and nothing more, so the stored shape
 * stays what it was. The id lives only on this device, for as long as the sheet is open: it
 * keys the row, so removing a step does not hand its focus and its press to the step below,
 * and it is what the grip moves. It is never sent.
 */
import type { ChecklistItem } from "@vemi/shared";

export interface KeyedStep extends ChecklistItem {
  readonly id: string;
}

/**
 * Ids for a list of steps, keeping the ones `held` already gave the same steps. A step keeps
 * its id when a step of the same text, not yet matched, is in `held`; the first such, in
 * order, so two steps of one text keep theirs in the order they had them. Anything else is
 * new and gets `make()`.
 */
export function keyed(held: readonly KeyedStep[], next: readonly ChecklistItem[], make: () => string): KeyedStep[] {
  const free = [...held];
  return next.map((item) => {
    const at = free.findIndex((h) => h.text === item.text);
    const id = at < 0 ? make() : (free.splice(at, 1)[0] as KeyedStep).id;
    return { id, text: item.text, done: item.done };
  });
}

/** What is stored: the steps without their ids. */
export const stored = (steps: readonly KeyedStep[]): ChecklistItem[] => steps.map(({ text, done }) => ({ text, done }));

/** The step `id` at index `to` of the list without it, the way `OrderedRows` counts. */
export function movedTo(steps: readonly KeyedStep[], id: string, to: number): KeyedStep[] {
  const moving = steps.find((s) => s.id === id);
  if (moving === undefined) return [...steps];
  const rest = steps.filter((s) => s.id !== id);
  const at = Math.max(0, Math.min(rest.length, to));
  return [...rest.slice(0, at), moving, ...rest.slice(at)];
}
