/**
 * Search over locked content, done on this device. The Worker holds only envelopes and cannot
 * match inside them, so the list it gives at `GET /api/locked` is opened here with the key this
 * device holds and matched the way the Worker matches its own text: a case-blind substring, a
 * kind's own allowance, the listed text that starts with the words first, then A to Z.
 *
 * With the key closed nothing is opened and nothing is answered, so a search says nothing
 * about whether locked items exist. Nothing here sends anything.
 */
import { SEARCH_KINDS, SEARCH_MOST, type LockableKind, type SearchHit, type SearchKind } from "@vemi/shared";
import type { LockedField } from "./api.js";
import type { Vault } from "./vault.js";

/** A hit from locked content: the same shape as a server hit, marked as locked. */
export interface LockedHit extends SearchHit {
  readonly locked: true;
}

/** The part of the vault this search uses. */
export type LockedOpener = Pick<Vault, "openField">;

const KIND_OF: Record<LockedField["kind"], SearchKind> = { projects: "project", tasks: "task", notes: "note" };
/** A note's listed text is cut as the archive cuts it. */
const NOTE_LABEL_MAX = 120;

/**
 * The hits for `needle` among the sealed `fields`, opened with `vault`. One hit per record,
 * however many of its fields match. A field that cannot be opened is skipped without a word.
 * `nameOf` gives a project's or a task's own name, which the hit lists; a note lists its body.
 */
export async function lockedSearch(
  needle: string,
  fields: readonly LockedField[],
  vault: LockedOpener,
  nameOf: (kind: "project" | "task", id: string) => string | undefined = () => undefined,
): Promise<LockedHit[]> {
  const typed = needle.trim().toLocaleLowerCase();
  if (typed === "" || fields.length === 0) return [];
  const opened = await Promise.all(fields.map(async (f) => {
    const answer = await vault.openField(f.kind as LockableKind, f.id, f.field as never, f.value);
    return answer.status === "open" ? { f, text: answer.text } : null;
  }));
  const found = new Map<string, LockedHit>();
  for (const o of opened) {
    if (o === null || !o.text.toLocaleLowerCase().includes(typed)) continue;
    const { f } = o;
    const kind = KIND_OF[f.kind];
    const key = `${kind}:${f.id}`;
    if (found.has(key)) continue;
    const text = kind === "note" ? o.text.slice(0, NOTE_LABEL_MAX) : nameOf(kind as "project" | "task", f.id) ?? "";
    found.set(key, { kind, id: f.id, ventureId: f.ventureId, projectId: f.projectId, taskId: f.taskId, text, locked: true });
  }
  const lower = (h: SearchHit): string => h.text.toLocaleLowerCase();
  const rank = (h: SearchHit): number => lower(h).startsWith(typed) ? 0 : lower(h).includes(typed) ? 1 : 2;
  const by = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
  const hits = [...found.values()];
  return SEARCH_KINDS.flatMap((kind) => hits.filter((h) => h.kind === kind)
    .sort((a, b) => rank(a) - rank(b) || by(lower(a), lower(b)) || by(a.id, b.id))
    .slice(0, SEARCH_MOST[kind]));
}

/**
 * Server hits and locked hits as one list, in the order of SEARCH_KINDS. A record the Worker
 * already found keeps its own hit. Each kind keeps its own allowance.
 */
export function mergeLocked<T extends SearchHit>(plain: readonly T[], locked: readonly LockedHit[]): (T | LockedHit)[] {
  const have = new Set(plain.map((h) => `${h.kind}:${h.id}`));
  const all: (T | LockedHit)[] = [...plain, ...locked.filter((h) => !have.has(`${h.kind}:${h.id}`))];
  return SEARCH_KINDS.flatMap((kind) => all.filter((h) => h.kind === kind).slice(0, SEARCH_MOST[kind]));
}

/** Whether a hit came from locked content. */
export const isLockedHit = (hit: SearchHit): hit is LockedHit => (hit as { locked?: true }).locked === true;
