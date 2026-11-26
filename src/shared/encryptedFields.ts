/**
 * Which typed text is sealed when an account turns full encryption on, how a sealed value is
 * told from a plain one, and how a whole row or API object is sealed and opened. Pure: it
 * takes the field key as an argument and sends nothing anywhere.
 *
 * A cell is bound `{record: the row's id, field: the name listed here}`. Each checklist item's
 * text is its own envelope, bound `checklist.text`. Account settings have no id, so their
 * record is `settings`. Ids, parent ids, positions, dates, kinds, colours, flags and
 * timestamps are not listed and stay readable.
 *
 * The lockable fields (see locked.ts) are bound by `lockBinding` instead. An envelope already
 * in one of them is never touched here, whether sealing or opening.
 */
import { envelopeKeyRef, open, seal } from "./crypto/index.js";
import { LOCKABLE, isSealed, sealedMax } from "./locked.js";

export const ENCRYPTED_FIELDS = {
  ventures: ["name", "description", "monogram"],
  states: ["name"],
  stages: ["name"],
  projects: ["name", "description", "whoFor", "doneLooks", "openQuestions"],
  milestones: ["name"],
  tasks: ["title", "body"],
  blockers: ["reason", "person"],
  notes: ["body"],
  decisions: ["title", "body"],
  risks: ["title", "body"],
  links: ["url", "label"],
  tags: ["name"],
  savedFilters: ["name", "query"],
  settings: ["levelSpace", "levelProject", "levelMilestone", "levelTask", "defaultStages"],
} as const;

export type EncryptedKind = keyof typeof ENCRYPTED_FIELDS;

/** The binding field for one checklist item's text. */
export const CHECKLIST_FIELD = "checklist.text";

/** The record a settings object is bound to. */
export const SETTINGS_RECORD = "settings";

/** True when the whole text has the shape of one envelope. Nothing is decrypted. */
export function isEnvelopeShape(text: string): boolean {
  return isSealed(text);
}

/** The longest envelope a field of `max` plain characters (UTF-16 units) can come to. */
export function envelopeLimit(max: number): number {
  return sealedMax(max);
}

/** A walked row, and the fields that could not be walked. */
export interface Walked<T> {
  readonly row: T;
  /** Fields left as they were: a failed open names the field, a checklist item `checklist.text`. */
  readonly failed: readonly string[];
}

type Cells = Record<string, unknown>;

function recordOf(kind: EncryptedKind, row: Cells): string {
  if (kind === "settings") return SETTINGS_RECORD;
  const id = row["id"];
  if (typeof id !== "string" || id === "") {
    throw new TypeError(`A ${kind} row needs an id to be sealed or opened.`);
  }
  return id;
}

function lockable(kind: EncryptedKind, field: string): boolean {
  const names = (LOCKABLE as Readonly<Record<string, readonly string[]>>)[kind];
  return names !== undefined && names.includes(field);
}

type Step = (text: string, field: string) => Promise<string>;

/** Walks the listed fields and the checklist, applying `step` to each text. */
async function walk<T extends object>(kind: EncryptedKind, input: T, step: Step, failed: string[]): Promise<T> {
  const row: Cells = { ...(input as Cells) };
  for (const field of ENCRYPTED_FIELDS[kind] as readonly string[]) {
    const value = row[field];
    if (typeof value !== "string") continue;
    try {
      row[field] = await step(value, field);
    } catch {
      // A lockable field may hold a locked envelope (bound by lockBinding): not ours to open.
      if (!(lockable(kind, field) && isEnvelopeShape(value))) failed.push(field);
    }
  }
  const raw = row["checklist"];
  if (kind === "tasks" && raw !== undefined && raw !== null) {
    const asText = typeof raw === "string";
    let items: unknown;
    try {
      items = asText ? JSON.parse(raw) : raw;
    } catch {
      items = null;
    }
    if (Array.isArray(items)) {
      const next: unknown[] = [];
      for (const item of items as unknown[]) {
        const text = item !== null && typeof item === "object" ? (item as Cells)["text"] : undefined;
        if (typeof text === "string") {
          try {
            next.push({ ...(item as Cells), text: await step(text, CHECKLIST_FIELD) });
          } catch {
            failed.push(CHECKLIST_FIELD);
            next.push(item);
          }
        } else {
          next.push(item);
        }
      }
      row["checklist"] = asText ? JSON.stringify(next) : next;
    } else if (asText) {
      failed.push("checklist");
    }
  }
  return row as T;
}

/**
 * Seals each listed field of a row or API object, and each checklist item's text. A value that
 * is already an envelope of this key ref is left alone.
 */
export async function sealRecord<T extends object>(
  fieldKey: CryptoKey,
  keyRef: string,
  kind: EncryptedKind,
  row: T,
): Promise<Walked<T>> {
  const record = recordOf(kind, row as Cells);
  const failed: string[] = [];
  const sealed = await walk(
    kind,
    row,
    async (text, field) => {
      if (isEnvelopeShape(text) && envelopeKeyRef(text) === keyRef) return text;
      return seal(fieldKey, keyRef, text, { record, field });
    },
    failed,
  );
  return { row: sealed, failed };
}

/**
 * Opens each listed field of a row or API object, and each checklist item's text. Plain text is
 * returned as it is. A value that fails to open is returned as it is and its field is named in
 * `failed`.
 */
export async function openRecord<T extends object>(
  fieldKey: CryptoKey,
  keyRef: string,
  kind: EncryptedKind,
  row: T,
): Promise<Walked<T>> {
  const record = recordOf(kind, row as Cells);
  const failed: string[] = [];
  const opened = await walk(
    kind,
    row,
    async (text, field) => {
      if (!isEnvelopeShape(text)) return text;
      return open(fieldKey, text, { record, field, keyRef });
    },
    failed,
  );
  return { row: opened, failed };
}
