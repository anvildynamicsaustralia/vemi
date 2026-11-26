/**
 * Exporting on this device. The export is fetched as the Worker makes it, locked fields still
 * whole envelopes, and either saved like that or, after a way in, turned back to text here. The
 * Worker never sees the text, and nothing in this module sends anything.
 */
import { type LockableField, type LockableKind, isSealed, lockBinding, open } from "@vemi/shared";
import type { DeviceKey } from "./deviceKey.js";

/** Where each lockable field sits in an export: the table, and the column for each field name. */
export const EXPORT_COLUMNS: { readonly [K in LockableKind]: { readonly table: string; readonly columns: { readonly [F in LockableField<K>]: string } } } = {
  projects: { table: "project", columns: { description: "description", whoFor: "who_for", doneLooks: "done_looks", openQuestions: "open_questions" } },
  tasks: { table: "task", columns: { body: "body" } },
  notes: { table: "note", columns: { body: "body" } },
};

type Row = Record<string, unknown>;
type Tables = Record<string, Row[]>;

const KINDS = Object.keys(EXPORT_COLUMNS) as LockableKind[];

/** Every lockable cell of a document: kind, field (as clients name it), the row and its column. */
function* lockableCells(tables: Tables): Generator<{ kind: LockableKind; field: string; column: string; table: string; row: Row }> {
  for (const kind of KINDS) {
    const { table, columns } = EXPORT_COLUMNS[kind];
    for (const row of tables[table] ?? []) {
      for (const [field, column] of Object.entries(columns) as [string, string][]) yield { kind, field, column, table, row };
    }
  }
}

const tablesOf = (document: Readonly<Record<string, unknown>>): Tables => {
  const tables = document["tables"];
  return typeof tables === "object" && tables !== null && !Array.isArray(tables) ? (tables as Tables) : {};
};

/** How many locked fields an export holds. */
export function countSealed(document: Readonly<Record<string, unknown>>): number {
  let n = 0;
  for (const { row, column } of lockableCells(tablesOf(document))) {
    const value = row[column];
    if (typeof value === "string" && isSealed(value)) n++;
  }
  return n;
}

/**
 * A copy of the document with each locked field opened to text by `key`. A field this key cannot
 * open stays as the envelope it was, and is counted in `left`.
 */
export async function unlockExport(
  document: Readonly<Record<string, unknown>>,
  key: Pick<DeviceKey, "fieldKey" | "keyRef">,
): Promise<{ readonly document: Record<string, unknown>; readonly left: number }> {
  const tables = tablesOf(document);
  const copy: Tables = {};
  for (const [name, rows] of Object.entries(tables)) copy[name] = rows.map((row) => ({ ...row }));
  let left = 0;
  for (const { kind, field, column, row } of lockableCells(copy)) {
    const value = row[column];
    if (typeof value !== "string" || !isSealed(value) || typeof row["id"] !== "string") continue;
    try {
      row[column] = await open(key.fieldKey, value, { ...lockBinding(kind, row["id"], field as LockableField<typeof kind>), keyRef: key.keyRef });
    } catch {
      left++;
    }
  }
  return { document: { ...document, tables: copy }, left };
}

/** The export as the Worker makes it. Not queued: a file made from nothing would be worse than none. */
export async function fetchExport(url: string, fetcher: typeof fetch = fetch): Promise<Record<string, unknown>> {
  const response = await fetcher(url, { headers: { accept: "application/json" } });
  if (!response.ok) throw new Error("Couldn't make the export. Try again.");
  const parsed: unknown = await response.json();
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("Couldn't make the export. Try again.");
  return parsed as Record<string, unknown>;
}

/** The file's name: `vemi-export-2026-11-19.json`. */
export function exportName(document: Readonly<Record<string, unknown>>, zone?: string): string {
  const at = document["exportedAt"];
  const instant = typeof at === "string" ? new Date(at) : null;
  // The person's own day names the file, as the Worker's download header does: late in a day ahead of UTC the stamp's date is still yesterday.
  const day = instant === null || Number.isNaN(instant.getTime()) ? "file" : new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }).format(instant);
  return `vemi-export-${day}.json`;
}

/** Hands the document to the browser as a download. */
export function saveExport(document: Readonly<Record<string, unknown>>): void {
  const blob = new Blob([JSON.stringify(document, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = window.document.createElement("a");
  link.href = url;
  link.download = exportName(document);
  window.document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
