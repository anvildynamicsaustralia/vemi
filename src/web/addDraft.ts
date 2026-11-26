/**
 * What was typed on Add and not yet made into a task, kept for the next time Add opens. A
 * stray tap or Escape should not cost a thought that was half written down.
 *
 * A title carried to Add — by a column's More, or by search — is kept the same way a title
 * typed there is: the place it was typed has gone by the time Add is showing, so a Cancel
 * that dropped it would lose the words for good.
 */
export interface Draft {
  /** The title Add opens on: a carried title, or else what was kept. */
  open(carried?: string): string;
  /** Keep what is in the title field now. */
  keep(text: string): void;
  /** The task was made, so there is nothing left to keep. */
  made(): void;
}

export function draftKeeper(): Draft {
  let kept = "";
  return {
    open(carried) {
      if (carried !== undefined && carried !== "") kept = carried;
      return kept;
    },
    keep(text) {
      kept = text;
    },
    made() {
      kept = "";
    },
  };
}
