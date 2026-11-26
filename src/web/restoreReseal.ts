/**
 * Restoring a file from an account with full encryption. The Worker gives every row a new id and
 * answers the old id to new id map (`ids`); an envelope is bound to its row's id, so each one
 * is resealed here from the old id to the new one and saved. Nothing in this module sends a key
 * or a text anywhere: it hands only envelopes to `steps`, and the field key stays on this device.
 *
 * A cell that opens under neither id is left as the file had it and counted. A cell that
 * already opens under the new id (a restore that was cut short and run again) is not touched.
 */
import {
  CHECKLIST_FIELD, ENCRYPTED_FIELDS, LOCKABLE, isEnvelopeShape, lockBinding, open, reseal,
  type EncryptedKind, type LockableField, type LockableKind,
} from "@vemi/shared";
import type { DeviceKey } from "./deviceKey.js";

type Row = Record<string, unknown>;
type Binding = { readonly record: string; readonly field: string };

/** The kinds a file's tables hold, and the table each is exported as. Settings stay with the account, which keeps its id. */
const TABLES: Readonly<Record<Exclude<EncryptedKind, "settings">, string>> = {
  ventures: "venture", states: "state", stages: "stage", projects: "project", milestones: "milestone",
  tasks: "task", blockers: "blocker", notes: "note", decisions: "decision", risks: "risk",
  links: "link", tags: "tag", savedFilters: "saved_filter",
};

/** The column of a field in an export: the field's name in snake case. */
const columnOf = (field: string): string => field.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

const lockedFields = (kind: string): readonly string[] =>
  (LOCKABLE as Readonly<Record<string, readonly string[]>>)[kind] ?? [];

/** Every binding an envelope in this field may carry: the lock's, for a lockable field, and the typed one. */
function bindings(kind: string, id: string, field: string): readonly Binding[] {
  const typed = { record: id, field };
  return lockedFields(kind).includes(field)
    ? [lockBinding(kind as LockableKind, id, field as LockableField<LockableKind>), typed]
    : [typed];
}

type Held = Pick<DeviceKey, "fieldKey" | "keyRef">;

/** A cell moved to its new id: the value is an envelope. */
export interface ResealPatch {
  readonly kind: Exclude<EncryptedKind, "settings" | "savedFilters">;
  /** The row's new id. */
  readonly id: string;
  /** Fields named as the app names them, each a whole envelope; `checklist` is the items, each text an envelope. */
  readonly fields: Readonly<Record<string, string | readonly { readonly text: string; readonly done: boolean }[]>>;
}

export interface ResealSteps {
  /** Saves resealed fields on a row now known by its new id. */
  save(patch: ResealPatch): Promise<void>;
  /**
   * A saved filter is bound to its id and its query cannot be changed in place, so it is made
   * again under `fresh`, with envelopes bound to `fresh`, and the restored one (`restored`) is put away.
   */
  replaceFilter(restored: string, fresh: string, filter: { readonly name: string; readonly query: string }): Promise<void>;
}

export interface ResealResult {
  /** Cells moved to their new id and saved. */
  readonly resealed: number;
  /** Cells that open under neither id, left as the file had them. */
  readonly left: number;
}

/** How many envelopes a file holds in typed cells, locked or not. Counts only; nothing is opened. */
export function countEnvelopes(document: Readonly<Record<string, unknown>>): number {
  const tables = document["tables"];
  if (typeof tables !== "object" || tables === null) return 0;
  let n = 0;
  for (const [kind, table] of Object.entries(TABLES)) {
    const rows = (tables as Record<string, unknown>)[table];
    if (!Array.isArray(rows)) continue;
    for (const row of rows as Row[]) {
      for (const field of ENCRYPTED_FIELDS[kind as keyof typeof TABLES] as readonly string[]) {
        const v = row[columnOf(field)];
        if (typeof v === "string" && isEnvelopeShape(v)) n++;
      }
      for (const text of checklistTexts(row)) if (isEnvelopeShape(text)) n++;
    }
  }
  return n;
}

function checklistTexts(row: Row): string[] {
  const raw = row["checklist"];
  if (typeof raw !== "string") return [];
  try {
    const items = JSON.parse(raw) as unknown;
    return Array.isArray(items)
      ? items.map((i) => (i !== null && typeof i === "object" ? (i as Row)["text"] : undefined)).filter((t): t is string => typeof t === "string")
      : [];
  } catch {
    return [];
  }
}

type Moved = { readonly value: string } | "kept" | "left";

/** One envelope from the old id to the new, trying each binding it may carry. */
async function move(key: Held, envelope: string, kind: string, from: string, to: string, field: string): Promise<Moved> {
  const old = bindings(kind, from, field);
  const now = bindings(kind, to, field);
  // Already under the new id (a restore run again): nothing to move.
  for (const binding of now) {
    try {
      await open(key.fieldKey, envelope, { ...binding, keyRef: key.keyRef });
      return "kept";
    } catch {
      // Not bound this way, or not this key.
    }
  }
  for (const [n, binding] of old.entries()) {
    try {
      return { value: await reseal(key.fieldKey, envelope, binding, now[n] ?? binding) };
    } catch {
      // Not bound this way: try the next.
    }
  }
  return "left";
}

/**
 * Reseals every envelope in `document` from its row's old id to the new one in `ids`, and saves
 * each row's moved cells through `steps`. Call after the Worker has restored and answered `ids`.
 */
export async function restoreReseal(
  document: Readonly<Record<string, unknown>>,
  ids: Readonly<Record<string, string>>,
  key: Held,
  steps: ResealSteps,
): Promise<ResealResult> {
  const tables = (typeof document["tables"] === "object" && document["tables"] !== null ? document["tables"] : {}) as Record<string, unknown>;
  let resealed = 0;
  let left = 0;
  for (const [kind, table] of Object.entries(TABLES) as [keyof typeof TABLES, string][]) {
    const rows = tables[table];
    if (!Array.isArray(rows)) continue;
    for (const row of rows as Row[]) {
      const from = row["id"];
      const to = typeof from === "string" ? ids[from] : undefined;
      if (typeof from !== "string" || to === undefined) continue;
      const fields: Record<string, string | { text: string; done: boolean }[]> = {};
      let moved = 0;
      const fresh = kind === "savedFilters" ? crypto.randomUUID() : to;
      for (const field of ENCRYPTED_FIELDS[kind] as readonly string[]) {
        const value = row[columnOf(field)];
        if (typeof value !== "string" || !isEnvelopeShape(value)) continue;
        const out = await move(key, value, kind, from, fresh, field);
        if (out === "left") left++;
        else if (out !== "kept") { fields[field] = out.value; moved++; }
      }
      const items: { text: string; done: boolean }[] = [];
      let touched = false;
      const raw = typeof row["checklist"] === "string" ? row["checklist"] : null;
      if (raw !== null) {
        try {
          for (const item of JSON.parse(raw) as Row[]) {
            const text = item["text"];
            const done = item["done"] === true;
            if (typeof text !== "string" || !isEnvelopeShape(text)) { items.push({ text: String(text ?? ""), done }); continue; }
            const out = await move(key, text, kind, from, to, CHECKLIST_FIELD);
            if (out === "left") { left++; items.push({ text, done }); continue; }
            if (out === "kept") { items.push({ text, done }); continue; }
            items.push({ text: out.value, done });
            touched = true;
            moved++;
          }
        } catch {
          // A checklist that is not a list is not ours.
        }
      }
      if (touched) fields["checklist"] = items;
      if (moved === 0) continue;
      if (kind === "savedFilters") {
        const name = fields["name"];
        const query = fields["query"];
        // Both must be moved together; one that could not be is left with the row as it was.
        if (typeof name === "string" && typeof query === "string") await steps.replaceFilter(to, fresh, { name, query });
        else left += moved;
        if (typeof name === "string" && typeof query === "string") resealed += moved;
        continue;
      }
      await steps.save({ kind: kind as ResealPatch["kind"], id: to, fields });
      resealed += moved;
    }
  }
  return { resealed, left };
}
