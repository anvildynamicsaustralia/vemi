/**
 * The shape of a full-account export: one JSON file with everything an owner made.
 *
 * It mirrors the schema instead of mapping it, so a new column shows up with no upkeep and
 * no rename. Each key in `tables` is a real table name, holding that table's rows exactly
 * as stored (snake_case columns, `owner` stripped, archived rows included). It lives in the
 * shared package, not the API, so the client can name the type without importing the store.
 *
 * Version 2 adds `settings`: what the account chose for its copy (look, level names,
 * reminders, time zone), as the appearance route reads it. Version 1 files have none and are
 * still read by a restore.
 */
export const EXPORT_VERSIONS = [1, 2] as const;

export interface ExportDocument {
  readonly format: "vemi-export";
  readonly version: 2;
  readonly exportedAt: string;
  readonly about: string;
  readonly settings: Record<string, unknown>;
  readonly tables: Record<string, Record<string, unknown>[]>;
}
