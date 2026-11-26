/**
 * A field's save on its way to the Worker: what it shows meanwhile, and when that ends.
 *
 * A title or a body that is saved shows what was typed, not the old text, for the whole
 * round trip, and goes on showing it while a write this device kept waits to be sent. It
 * gives way once `value` moves off what the save replaced: the answer has come back, in
 * whatever form the Worker stored it.
 *
 * Or once the screen has been read again after the write left this device. A value still
 * at what the save replaced is then what the Worker holds — the write was refused when the
 * outbox sent it, or undone before the first read came — and the typed text must not
 * outlive it. Pure, so the rule can be proved without a component.
 */

export interface Saving {
  /** What was typed and saved. */
  readonly text: string;
  /** The value it replaced. */
  readonly from: string | null;
  /**
   * Null while the write is still on this device: on its way, or kept in the outbox. Once
   * the Worker has answered it, or the outbox has sent or refused it, the number of the
   * next read to begin (`readsBegun` in state/resources.ts).
   */
  readonly after: number | null;
}

/** What the field shows. */
export const shownValue = (value: string | null, saving: Saving | null): string | null =>
  saving === null ? value : saving.text;

/**
 * Whether the answer has come back, so the field shows `value` again. `readAgain` is whether
 * the screen has been read from the Worker by a read numbered `saving.after` or later.
 */
export const answered = (value: string | null, saving: Saving | null, readAgain: boolean): boolean =>
  saving !== null && (value !== saving.from || (saving.after !== null && readAgain));
