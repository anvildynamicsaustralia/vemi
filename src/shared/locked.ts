/**
 * Which text a person can lock, how a locked field is told from a plain one, and what it is
 * bound to. A locked field is its whole text being one `v1.` envelope (see crypto/envelope.ts);
 * there is no lock column. The Worker only ever holds the envelope.
 */

/** The fields that can be locked, by record kind. */
export const LOCKABLE = {
  projects: ["description", "whoFor", "doneLooks", "openQuestions"],
  tasks: ["body"],
  notes: ["body"],
} as const;

export type LockableKind = keyof typeof LOCKABLE;
export type LockableField<K extends LockableKind = LockableKind> = (typeof LOCKABLE)[K][number];

// v1.<keyRef: 8 bytes = 11 chars>.<iv: 12 bytes = 16 chars>.<data: at least the 16-byte tag = 22 chars>
const SEALED = /^v1\.[A-Za-z0-9_-]{11}\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{22,}$/;

/** True when the whole text is one sealed envelope. Nothing around it, no space, no fourth dot. */
export function isSealed(text: string): boolean {
  return SEALED.test(text);
}

const PREFIX_CHARS = 3 + 11 + 1 + 16 + 1; // "v1." keyRef "." iv "."
const TAG_BYTES = 16;
const MAX_BYTES_PER_UNIT = 3; // UTF-8 bytes for one UTF-16 unit: 3 at most (a pair of units takes 4)

/**
 * The longest envelope a field with this plain limit may hold, in UTF-16 units. A limit counts
 * UTF-16 units; the worst case is every unit taking three bytes of UTF-8, plus the tag.
 */
export function sealedMax(plainMax: number): number {
  const bytes = plainMax * MAX_BYTES_PER_UNIT + TAG_BYTES;
  return PREFIX_CHARS + Math.ceil((bytes * 4) / 3);
}

/** What a sealed field is bound to, so it cannot be pasted into another field or row. */
export function lockBinding<K extends LockableKind>(
  kind: K,
  id: string,
  field: LockableField<K>,
): { record: string; field: string } {
  return { record: id, field: `${kind}.${field}` };
}
