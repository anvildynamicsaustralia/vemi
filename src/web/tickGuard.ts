/**
 * A double click on Done. The first click finishes the task on the Next up card and the card
 * at once shows the one after it, with its Done button in the same place, so the second click
 * of the pair would finish a task nobody chose. A tick on a different task within this many
 * milliseconds of the last tick is that second click, and is let go.
 */
export const DOUBLE_CLICK_MS = 450;

export interface LastTick {
  readonly id: string;
  readonly at: number;
}

/** Whether a tick on `id` at `now` is the second click of a double click on another task's Done. */
export function isStray(last: LastTick | null, id: string, now: number): boolean {
  return last !== null && last.id !== id && now - last.at < DOUBLE_CLICK_MS;
}
