import { EXPORT_VERSIONS } from "@vemi/shared";
import { longDate } from "./format.js";

/** Reading a chosen export file before it is sent, and the words for what it holds. */

export type RestoreRead =
  | { readonly ok: true; readonly document: Record<string, unknown> }
  | { readonly ok: false; readonly error: string };

const NOT_EXPORT = "This is not a VEMI export file.";

/** The file's text, checked for the shape of an export. The Worker checks it again and answers the counts. */
export function readRestoreFile(text: string): RestoreRead {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, error: NOT_EXPORT };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return { ok: false, error: NOT_EXPORT };
  const document = parsed as Record<string, unknown>;
  if (document["format"] !== "vemi-export") return { ok: false, error: NOT_EXPORT };
  if (!(EXPORT_VERSIONS as readonly unknown[]).includes(document["version"])) {
    return { ok: false, error: `This export is version ${String(document["version"])}. This copy reads ${EXPORT_VERSIONS.join(" and ")}.` };
  }
  const tables = document["tables"];
  if (typeof tables !== "object" || tables === null || Array.isArray(tables)) {
    return { ok: false, error: "This export holds no tables." };
  }
  return { ok: true, document };
}

/** One line a table, in name order, with the empty ones left out. */
export function countLines(counts: Readonly<Record<string, number>>): string[] {
  return Object.entries(counts)
    .filter(([, n]) => n > 0)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([name, n]) => `${name.replace(/_/g, " ")}: ${n}`);
}

/** The day an account goes, from the Worker's time: `26 November`. */
export function deletionDay(deleteOn: string): string {
  return longDate(deleteOn.slice(0, 10));
}
