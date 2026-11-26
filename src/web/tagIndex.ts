/**
 * What the tag picker is looking at: what this record already carries, what else exists,
 * and what the typed word matches. Pure.
 *
 * Tags earn their place by being few and reused, which is why a new one is made only after
 * the existing ones have been offered and refused. The database enforces half of that — two
 * live tags of one owner cannot share a name — but a 409 arriving after the fact is a
 * correction, not a choice. `exact` below is the other half: while a typed word already
 * names a tag, the picker has something to offer and "make a new tag" has no reason to
 * appear at all.
 *
 * Nothing here knows about colour, and there is nothing here that could carry one. Two tags
 * are told apart by their words.
 */

/** Anything with an id and a name: a `Tag`, and in a test, less than one. */
interface Named {
  readonly id: string;
  readonly name: string;
}

export interface TagIndex<T extends Named> {
  /** The tags this record carries, in name order. */
  readonly chosen: readonly T[];
  /** Every other tag that exists, in name order. */
  readonly unchosen: readonly T[];
  /** The unchosen ones the typed word matches, in name order. Everything, while nothing is typed. */
  readonly matches: readonly T[];
  /** The tag the typed word already names, chosen or not. While this is a tag, no new one is offered. */
  readonly exact: T | null;
}

/** A name compared the way a person compares two: without case, and without the padding. */
const same = (name: string): string => name.trim().toLowerCase();

/** By name, and by id when two names read alike, so the order never depends on the input's. */
const byName = <T extends Named>(a: T, b: T): number => a.name.localeCompare(b.name) || a.id.localeCompare(b.id);

/**
 * `tags` is every tag that exists, `tagIds` the ids this record holds, `typed` what has been
 * put in the field. An id naming no tag is passed over rather than refused: an archived tag
 * is dropped from `tagIds` on the read path, and the picker only ever shows what it was told
 * about.
 */
export function tagIndex<T extends Named>(tags: readonly T[], tagIds: readonly string[], typed: string): TagIndex<T> {
  const held = new Set(tagIds);
  const chosen: T[] = [];
  const unchosen: T[] = [];
  let exact: T | null = null;

  const wanted = same(typed);
  for (const tag of tags) {
    (held.has(tag.id) ? chosen : unchosen).push(tag);
    if (exact === null && wanted !== "" && same(tag.name) === wanted) exact = tag;
  }
  chosen.sort(byName);
  unchosen.sort(byName);

  // A word matches anywhere in a name, not only at its start: "work" should find "deep work".
  const matches = wanted === "" ? unchosen : unchosen.filter((tag) => tag.name.toLowerCase().includes(wanted));
  return { chosen, unchosen, matches, exact };
}
