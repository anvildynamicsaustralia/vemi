/**
 * "Decisions and risks" in a ⋯ menu asks for the ledger, then navigates. The page it lands
 * on takes the ask once and brings the ledger into view. "About this venture" asks the same
 * way for the top of a venture's About. One ask is remembered, in memory only: an ask that is
 * never taken is replaced by the next, and a reload forgets it.
 */

/** What an ask brings into view: the ledger, or the head of a venture's About. */
export type Reach = "ledger" | "about";

/** One ask: which venture's or project's page, and what it brings into view. */
export interface Asked {
  readonly id: string;
  readonly reach: Reach;
}

let asked: Asked | null = null;
const listeners = new Set<() => void>();

/** Hear every ask, so a page that is already open can take it. Returns the way to stop. */
export function onLedgerAsk(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Remember an ask as it stands: a search hit says which of the two it wants. */
export function ask(id: string, reach: Reach): void {
  asked = { id, reach };
  for (const listener of [...listeners]) listener();
}

/** Remember that the page for this venture or project should open on its ledger. */
export function askForLedger(id: string): void {
  ask(id, "ledger");
}

/** Remember that this venture's Projects should open its About and show the top of it. */
export function askForAbout(ventureId: string): void {
  ask(ventureId, "about");
}

/** What was asked for, once, for the id it was asked for; then forgotten. Null for any other id. */
export function takeLedgerAsk(id: string): Reach | null {
  if (asked === null || asked.id !== id) return null;
  const { reach } = asked;
  asked = null;
  return reach;
}
