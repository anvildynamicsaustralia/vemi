/**
 * What became of a write, as every caller of `act` is told it.
 *
 * `"sent"` is a write the Worker took. `"kept"` is one this device is holding until there is
 * a connection: the notice says so, and a caller that would say "Moved to Done" over the
 * top of that notice says nothing instead, so nobody offline is told a thing landed that
 * has only been kept. `false` is a write that did not happen, and has been answered.
 *
 * Pure, so the sorting can be proved without a Worker or an outbox.
 */

export type Outcome = "sent" | "kept" | false;

/** Said when a write, or the way back from one, is held on this device rather than sent. */
export const KEPT = "Kept on this device. It sends when the connection is back.";

/** A write this device is holding until the Worker can be reached. */
export interface Queued {
  readonly queued: true;
}

export function isQueued(value: unknown): value is Queued {
  return typeof value === "object" && value !== null && (value as { queued?: unknown }).queued === true;
}

/**
 * Whether a write's answer was kept rather than sent. A batch — a drag that writes several
 * positions, a bulk edit, a bulk archive — answers with a list, nested as deep as the
 * caller built it; it was kept when any write in it was.
 */
export function wasKept(answer: unknown): boolean {
  return Array.isArray(answer) ? answer.some(wasKept) : isQueued(answer);
}

/** The outcome of a write that answered. */
export const outcomeOf = (answer: unknown): Outcome => (wasKept(answer) ? "kept" : "sent");
