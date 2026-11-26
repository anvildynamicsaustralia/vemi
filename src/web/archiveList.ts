import { KINDS, type ArchivedItem, type Kind } from "@vemi/shared";

/**
 * What the archive shows: everything archived in, the rows that match what was typed and the
 * kinds chosen out. Pure.
 *
 * "Out of the way, not gone" stops being true the moment the archive cannot be searched. The
 * whole archive is already in memory — the Worker sends it in one batch — so this is a filter
 * over that list and not a second query. `store.search()` is the inverse of this on purpose:
 * it only ever looks at what is not archived.
 *
 * The kinds offered are the kinds the archive holds, not a fixed list. A fixed list would hide
 * every archived note, blocker or tag behind a filter with no chip for it, which is the
 * failure this exists to fix, and it would drift the day the model gains a kind.
 */

export interface ArchiveFilter {
  /** What was put in the field. */
  readonly typed: string;
  /** The kinds chosen. None chosen means every kind. */
  readonly kinds: ReadonlySet<Kind>;
}

export interface ArchiveView {
  /** The rows to draw, newest first. */
  readonly shown: readonly ArchivedItem[];
  /**
   * Every kind present in the archive, in the model's order, with how many of it match what
   * was typed. Counted before the kind filter, so choosing a kind never takes the other
   * chips' counts to nothing, and never counted over nothing, so no chip is offered for a
   * kind the archive does not hold.
   */
  readonly kinds: readonly { readonly kind: Kind; readonly of: number }[];
  /** How many things are archived in all. */
  readonly of: number;
}

/**
 * Text compared the way a person compares it: without case, and with every run of spaces and
 * line breaks read as one space. A note's label is prose with its line breaks kept, and a
 * word typed across one should still find it.
 */
const plain = (text: string): string => text.toLowerCase().replace(/\s+/g, " ").trim();

export function archiveList(items: readonly ArchivedItem[], filter: ArchiveFilter): ArchiveView {
  const needle = plain(filter.typed);
  // A word matches anywhere in a label, not only at its start — the tag picker's rule too.
  const typed = needle === "" ? [...items] : items.filter((item) => plain(item.label).includes(needle));

  const held = new Set(items.map((item) => item.kind));
  const counted = new Map<Kind, number>();
  for (const item of typed) counted.set(item.kind, (counted.get(item.kind) ?? 0) + 1);
  const kinds = KINDS.filter((kind) => held.has(kind)).map((kind) => ({ kind, of: counted.get(kind) ?? 0 }));

  // A chosen kind the archive no longer holds has no chip to let go of, so it cannot narrow.
  const chosen = [...filter.kinds].filter((kind) => held.has(kind));
  const wanted = new Set(chosen);
  const shown = (wanted.size === 0 ? typed : typed.filter((item) => wanted.has(item.kind)))
    .sort((a, b) => b.archivedAt.localeCompare(a.archivedAt));

  return { shown, kinds, of: items.length };
}

/**
 * The kinds still chosen once the archive has changed. A kind the archive no longer holds has
 * no chip, so it is let go of here rather than kept in state: kept, it would narrow the list
 * again the moment an undo put one of its rows back, with no sign that anything was chosen.
 * The same set comes back when nothing is let go of.
 */
export function keptKinds(items: readonly ArchivedItem[], chosen: ReadonlySet<Kind>): ReadonlySet<Kind> {
  const held = new Set(items.map((item) => item.kind));
  const kept = [...chosen].filter((kind) => held.has(kind));
  return kept.length === chosen.size ? chosen : new Set(kept);
}

/** The two calls a bulk restore's undo and redo are made of, one row at a time. */
export interface RestoreCalls {
  archive(item: ArchivedItem): Promise<unknown>;
  unarchive(item: ArchivedItem): Promise<unknown>;
}

/** One call after another, so the outbox keeps them in the order given. */
async function inTurn(items: readonly ArchivedItem[], call: (item: ArchivedItem) => Promise<unknown>): Promise<unknown> {
  let last: unknown = undefined;
  for (const item of items) last = await call(item);
  return last;
}

/**
 * The way back from restoring `back` — the rows that came back, in the order they were
 * restored, which is the order they were listed: newest archived first.
 *
 * Undo archives them again oldest first, the order they first went into the archive. That
 * order was valid by construction; the listed one is not. A state cannot be archived while a
 * live task sits in it, so re-archiving a state before the task that sat in it is refused
 * part-way, the step is dropped, and there is neither the rest of the undo nor a redo.
 *
 * Redo restores in the order the restore first ran, which the Worker has already accepted.
 * No restore is refused for another row being archived, only for a live twin by name, so
 * redo has no mirror of the undo's hazard; keeping the first order keeps it that way.
 */
export function restoreSteps(back: readonly ArchivedItem[], calls: RestoreCalls): {
  undo(): Promise<unknown>;
  redo(): Promise<unknown>;
} {
  // Read when the step runs, not now: the caller fills `back` as the restore goes.
  return {
    undo: () => inTurn([...back].reverse(), (item) => calls.archive(item)),
    redo: () => inTurn(back, (item) => calls.unarchive(item)),
  };
}

/**
 * The archived parents a restored record still sits under: the project, the parent project,
 * then the venture.
 *
 * Whether a thing shows is read from its parents, so a project restored while its venture is
 * still archived leaves the archive and shows nowhere until the venture comes back. To a
 * person that reads as the thing being lost. The Worker answers a restore with the record,
 * and the record names its parents, so the archive can say what it waits for. A queued
 * answer names nothing.
 */
export function waitingOn(record: unknown, archive: readonly ArchivedItem[]): readonly ArchivedItem[] {
  if (typeof record !== "object" || record === null) return [];
  const { projectId, parentId, ventureId } = record as {
    readonly projectId?: unknown;
    readonly parentId?: unknown;
    readonly ventureId?: unknown;
  };
  const parent = (kind: Kind, id: unknown): ArchivedItem | undefined =>
    typeof id === "string" ? archive.find((item) => item.kind === kind && item.id === id) : undefined;
  // A record in a live child of an archived project hides with that project, though it names
  // only the child. The archived project says which children it holds.
  const holder = (id: unknown): ArchivedItem | undefined =>
    typeof id === "string" && parent("projects", id) === undefined
      ? archive.find((item) => item.kind === "projects" && item.holds?.includes(id))
      : undefined;
  const found = [parent("projects", projectId), holder(projectId), parent("projects", parentId), parent("ventures", ventureId)]
    .filter((item): item is ArchivedItem => item !== undefined);
  return found.filter((item, at) => found.indexOf(item) === at);
}

/** "Slice", "Slice and Chase", "Slice, Chase and Bake". */
const and = (words: readonly string[]): string =>
  words.length <= 1 ? (words[0] ?? "") : `${words.slice(0, -1).join(", ")} and ${words.at(-1) ?? ""}`;

/** "once Studios is restored", "once Slice and Studios are restored". */
export const once = (on: readonly ArchivedItem[]): string =>
  `once ${and(on.map((item) => item.label))} ${on.length === 1 ? "is" : "are"} restored`;

/**
 * What the restored things still wait for, one sentence for each set of parents, in the
 * order first met. Nothing when nothing waits.
 */
export function waitingSaid(waits: readonly { readonly label: string; readonly on: readonly ArchivedItem[] }[]): string {
  const groups = new Map<string, { readonly on: readonly ArchivedItem[]; readonly labels: string[] }>();
  for (const wait of waits) {
    if (wait.on.length === 0) continue;
    const key = wait.on.map((item) => `${item.kind}:${item.id}`).join(" ");
    const group = groups.get(key) ?? { on: wait.on, labels: [] };
    group.labels.push(wait.label);
    groups.set(key, group);
  }
  return [...groups.values()]
    .map(({ on, labels }) => `${and(labels)} ${labels.length === 1 ? "shows" : "show"} ${once(on)}.`)
    .join(" ");
}
