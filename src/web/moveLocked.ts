/**
 * Locked and encrypted content in a move (move-to-cloud, Task 6). A document that holds locked
 * rows or full encryption moves as it was exported: envelopes and its own `key_wrap` rows, and
 * nothing here opens a text to send it. Before the move the person opens the key by one of their
 * own ways in, so a move that could never be finished is not started. After Open my VEMI, a
 * finishing pass moves each envelope from its row's old id to the new one on the new copy.
 */
import type { KeyState } from "./api.js";
import { countSealed } from "./exportLocked.js";
import type { DeviceKey } from "./deviceKey.js";
import type { OpenWay, Passkeys } from "./keyWays.js";
import { fileKeyState, openKey } from "./restoreLocked.js";
import { countEnvelopes, restoreReseal, type ResealResult, type ResealSteps } from "./restoreReseal.js";

type Row = Record<string, unknown>;
type Document = Readonly<Record<string, unknown>>;
type Held = Pick<DeviceKey, "fieldKey" | "keyRef">;

export const FINISHING = "Finishing your locked notes";
export const PASSKEY_LINE = "Your passkey stays with this device. Add one in your new VEMI to open locked notes there.";
export const NOT_HELD = "That file does not hold a key to open its locked notes.";

/** What a document holds that needs its key: locked rows, typed (encrypted) cells, and the key rows to open them. */
export interface LockedHeld {
  readonly locked: number;
  readonly typed: number;
  readonly keys: KeyState | null;
}

export function lockedHeld(document: Document): LockedHeld {
  const locked = countSealed(document);
  const typed = countEnvelopes(document);
  return { locked, typed, keys: locked + typed > 0 ? fileKeyState(document) : null };
}

/** True when the move must open a key first. */
export const needsKey = (held: LockedHeld): boolean => held.locked + held.typed > 0;

/** The line that the passkey does not come: shown only when the file held a locked row. */
export const passkeyLine = (held: LockedHeld): string | null => (held.locked > 0 ? PASSKEY_LINE : null);

/** One sentence for cells that open under neither id, or null when none were left. */
export function leftSentence(left: number): string | null {
  if (left <= 0) return null;
  return left === 1
    ? "1 locked item could not be opened and stays as the file had it."
    : `${left} locked items could not be opened and stay as the file had them.`;
}

/**
 * Before sending: one of the file's own ways in opens its key. Throws the key way's own sentence for
 * a wrong one, so nothing is sent. A file that holds locked content but no key rows cannot move.
 */
export async function openBeforeSend(
  account: string, document: Document, way: OpenWay, passkeys?: Passkeys,
): Promise<Held> {
  const held = lockedHeld(document);
  if (!needsKey(held)) throw new Error("There is nothing locked in this file.");
  if (held.keys === null) throw new Error(NOT_HELD);
  return openKey(account, held.keys, way, passkeys);
}

/** The tables of a document, or an empty set. */
function tablesOf(document: Document): Record<string, Row[]> {
  const tables = document["tables"];
  return typeof tables === "object" && tables !== null && !Array.isArray(tables) ? (tables as Record<string, Row[]>) : {};
}

/**
 * Every cell, in every table, that holds one of the `texts` in the clear. A locked field's text
 * must be nowhere on the new copy; an envelope hides it, so a hit means something readable was sent.
 */
export function readableCells(document: Document, texts: readonly string[]): readonly string[] {
  const found: string[] = [];
  const wanted = texts.filter((t) => t !== "");
  for (const [table, rows] of Object.entries(tablesOf(document))) {
    if (!Array.isArray(rows)) continue;
    for (const row of rows) {
      for (const [column, value] of Object.entries(row)) {
        if (typeof value === "string" && wanted.some((t) => value.includes(t))) found.push(`${table}.${column}`);
      }
    }
  }
  return found;
}

/** The envelope-bearing columns of a row: the cells a restore carries over as they were. */
const envelopesOf = (row: Row): [string, string][] =>
  Object.entries(row).filter((e): e is [string, string] => typeof e[1] === "string" && /^v\d+\./.test(e[1]));

/**
 * The old id to new id map, read from the new copy itself: an envelope arrives byte for byte, and
 * no two share a nonce, so the file's row and the copy's row that hold the same envelope are the
 * same row. Used when the answer's own `ids` did not reach this origin (the tab was closed).
 */
export function idsFromCopy(file: Document, copy: Document): Record<string, string> {
  const ids: Record<string, string> = {};
  const copyTables = tablesOf(copy);
  for (const [table, rows] of Object.entries(tablesOf(file))) {
    if (!Array.isArray(rows)) continue;
    const there = copyTables[table] ?? [];
    for (const row of rows) {
      const from = row["id"];
      if (typeof from !== "string") continue;
      const cells = envelopesOf(row);
      if (cells.length === 0) continue;
      const match = there.find((r) => typeof r["id"] === "string" && envelopesOf(r).some(([, v]) => cells.some(([, w]) => w === v)));
      if (match !== undefined) ids[from] = match["id"] as string;
    }
  }
  return ids;
}

/**
 * The finishing pass: moves each envelope from its row's old id to the new one and saves it on
 * the signed-in new copy. A cell that opens under neither id is counted and left as it was.
 * Safe to run again: a cell already under its new id is not touched.
 */
export async function finishLocked(
  file: Document, ids: Readonly<Record<string, string>>, key: Held, steps: ResealSteps,
): Promise<ResealResult & { readonly said: string | null }> {
  const done = await restoreReseal(file, ids, key, steps);
  return { ...done, said: leftSentence(done.left) };
}

const PENDING_KEY = "vemi:move:finishing";

/** Remembers on the new origin that the finishing pass is not done, so a closed tab resumes it. Ids only: never a key or a text. */
export function markFinishing(ids: Readonly<Record<string, string>>, store: Pick<Storage, "setItem"> = localStorage): void {
  try { store.setItem(PENDING_KEY, JSON.stringify({ v: 1, ids })); } catch { /* nothing kept: the file is asked for again */ }
}

export function pendingFinishing(store: Pick<Storage, "getItem"> = localStorage): Record<string, string> | null {
  try {
    const raw = store.getItem(PENDING_KEY);
    if (raw === null) return null;
    const read = JSON.parse(raw) as { v?: unknown; ids?: unknown };
    if (read.v !== 1 || typeof read.ids !== "object" || read.ids === null) return null;
    return read.ids as Record<string, string>;
  } catch {
    return null;
  }
}

export function clearFinishing(store: Pick<Storage, "removeItem"> = localStorage): void {
  try { store.removeItem(PENDING_KEY); } catch { /* nothing to clear */ }
}

/** Whether the page was opened by a move that carried locked content: the new copy's hand-over lands on `/?finishing=1`. */
export const finishingMarked = (search: string): boolean => new URLSearchParams(search).get("finishing") === "1";

/** The export document in a file's text, or null when it is not one. */
export function exportFrom(text: string): Record<string, unknown> | null {
  try {
    const read = JSON.parse(text) as unknown;
    return typeof read === "object" && read !== null && !Array.isArray(read) && (read as Record<string, unknown>)["format"] === "vemi-export"
      ? (read as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}
