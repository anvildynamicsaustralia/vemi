/**
 * Turning full encryption on or off, from this device. The Worker holds text and counts what
 * is left; this reads the account's own export, seals or opens each typed cell with the key
 * held here, and sends the changed cells in batches of 50. It can be run again at any point:
 * what is already moved is not sent twice, and the Worker's count (`GET /api/encryption`) says
 * how far along it is and when it is finished.
 *
 * Nothing is deleted and nothing that cannot be opened is written: a cell that this key does
 * not open is left exactly as it is. The key and the plain text never leave this device.
 */
import {
  CHECKLIST_FIELD,
  ENCRYPTED_FIELDS,
  LOCKABLE,
  type EncryptedKind,
  SETTINGS_RECORD,
  isEnvelopeShape,
  open,
  seal,
} from "@vemi/shared";
import type { EncryptionApi, EncryptionReport, SealedRecord } from "./encryptionApi.js";
import type { EncryptionState } from "./sealedApi.js";

/** Said when writes are still waiting in the outbox, which would leave plain text in this browser. */
export const WAITING = "Changes are still waiting to be sent from this device, so this can't start yet.";
const NOT_YOURS = "This device holds a different key from the one this account uses, so nothing was changed.";
const CLOSED_OFF = "The key on this device doesn't open some of this account's text, so nothing more was written.";
const MOVED_ON = "Some text changed while it was being moved, so it stopped.";

/** How many records go in one batch: the Worker's own limit. */
export const BATCH = 50;
/** Passes over the account: text added while it runs is picked up by another. */
const PASSES = 6;

export interface HeldKey {
  readonly fieldKey: CryptoKey;
  readonly keyRef: string;
}

export interface Progress {
  /** Cells moved so far, by the Worker's own count. */
  readonly done: number;
  readonly total: number;
}

export interface RunDeps {
  readonly api: EncryptionApi;
  readonly key: HeldKey;
  /** The key the account uses, when known. A different key is refused before anything is sent. */
  readonly expectKeyRef?: string;
  /** How many writes wait in the outbox. */
  readonly waiting?: () => number;
  readonly progress?: (p: Progress) => void;
  /** Told where the account is, so the app opens and seals the way the Worker now enforces. */
  readonly setState?: (state: EncryptionState) => void;
  /** Called once the account is on: the reads this device kept in plain text go. */
  readonly forget?: () => Promise<void>;
}

export type RunEnd = { readonly ok: true } | { readonly ok: false; readonly said: string };

type Row = Record<string, unknown>;
type Tables = Readonly<Record<string, readonly Row[]>>;

const TABLE_KIND: Readonly<Record<string, EncryptedKind>> = {
  venture: "ventures", state: "states", stage: "stages", project: "projects", milestone: "milestones", task: "tasks",
  blocker: "blockers", note: "notes", decision: "decisions", risk: "risks", link: "links", tag: "tags", saved_filter: "savedFilters",
};
const snake = (field: string): string => field.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

const LEVELS = [["levelSpace", "space"], ["levelProject", "project"], ["levelMilestone", "milestone"], ["levelTask", "task"]] as const;

const isObject = (v: unknown): v is Row => typeof v === "object" && v !== null && !Array.isArray(v);

const lockable = (kind: string, field: string): boolean =>
  ((LOCKABLE as Readonly<Record<string, readonly string[]>>)[kind] ?? []).includes(field);

type Moved = { readonly same: true } | { readonly text: string } | { readonly unreadable: true };

interface Plan {
  readonly records: SealedRecord[];
  /** Cells this key does not open, left as they are. */
  unreadable: number;
}

/** One cell moved the way `to` says. A lockable field's envelope that this key does not open is the lock's, and is left. */
async function move(to: "on" | "off", key: HeldKey, text: string, bound: { record: string; field: string }, kind: string): Promise<Moved> {
  if (to === "on") {
    if (text === "" || isEnvelopeShape(text)) return { same: true };
    return { text: await seal(key.fieldKey, key.keyRef, text, bound) };
  }
  if (!isEnvelopeShape(text)) return { same: true };
  try {
    return { text: await open(key.fieldKey, text, { ...bound, keyRef: key.keyRef }) };
  } catch {
    return lockable(kind, bound.field) ? { same: true } : { unreadable: true };
  }
}

async function planRows(to: "on" | "off", key: HeldKey, tables: Tables, plan: Plan): Promise<void> {
  for (const [table, kind] of Object.entries(TABLE_KIND)) {
    for (const row of tables[table] ?? []) {
      const id = row["id"];
      if (typeof id !== "string") continue;
      const fields: Record<string, string | { text: string; done: boolean }[]> = {};
      for (const field of ENCRYPTED_FIELDS[kind] as readonly string[]) {
        const value = row[snake(field)];
        if (typeof value !== "string") continue;
        const moved = await move(to, key, value, { record: id, field }, kind);
        if ("text" in moved) fields[field] = moved.text;
        else if ("unreadable" in moved) plan.unreadable++;
      }
      if (kind === "tasks" && typeof row["checklist"] === "string") {
        let items: unknown;
        try {
          items = JSON.parse(row["checklist"]);
        } catch {
          items = null;
        }
        if (Array.isArray(items) && items.length > 0) {
          const next: { text: string; done: boolean }[] = [];
          let changed = false;
          let whole = true;
          for (const item of items as unknown[]) {
            const text = isObject(item) ? item["text"] : undefined;
            if (!isObject(item) || typeof text !== "string") { whole = false; break; }
            const moved = await move(to, key, text, { record: id, field: CHECKLIST_FIELD }, "tasks");
            if ("unreadable" in moved) { plan.unreadable++; whole = false; break; }
            next.push({ text: "text" in moved ? moved.text : text, done: item["done"] === true });
            if ("text" in moved) changed = true;
          }
          // A list goes whole or not at all: the Worker takes every step in the same state.
          if (whole && changed) fields["checklist"] = next;
        }
      }
      if (Object.keys(fields).length > 0) plan.records.push({ kind, id, fields });
    }
  }
}

async function planSettings(to: "on" | "off", key: HeldKey, doc: Row, accountId: string, plan: Plan): Promise<void> {
  const settings = doc["settings"];
  if (!isObject(settings)) return;
  const fields: Record<string, string> = {};
  const names = settings["levelNames"];
  if (isObject(names)) {
    for (const [field, level] of LEVELS) {
      const value = names[level];
      if (typeof value !== "string") continue;
      const moved = await move(to, key, value, { record: SETTINGS_RECORD, field }, "settings");
      if ("text" in moved) fields[field] = moved.text;
      else if ("unreadable" in moved) plan.unreadable++;
    }
  }
  const stages = settings["defaultStages"];
  const stageText = typeof stages === "string" ? stages : Array.isArray(stages) ? JSON.stringify(stages) : null;
  if (stageText !== null) {
    const moved = await move(to, key, stageText, { record: SETTINGS_RECORD, field: "defaultStages" }, "settings");
    if ("text" in moved) fields["defaultStages"] = moved.text;
    else if ("unreadable" in moved) plan.unreadable++;
  }
  if (Object.keys(fields).length > 0) plan.records.push({ kind: "settings", id: accountId, fields });
}

/** What the connector kept of a record before it changed it: one envelope a row, bound to the change. */
async function planConnector(to: "on" | "off", key: HeldKey, tables: Tables, plan: Plan): Promise<void> {
  for (const row of tables["connector_change"] ?? []) {
    const id = row["id"];
    const before = row["before"];
    if (typeof id !== "string" || typeof before !== "string") continue;
    const moved = await move(to, key, before, { record: id, field: "before" }, "connector_change");
    if ("text" in moved) plan.records.push({ kind: "connector_change", id, fields: { before: moved.text } });
    else if ("unreadable" in moved) plan.unreadable++;
  }
}

/** Every typed cell of the account that is not yet where `to` wants it, in batches' order: settings, then the connector last. */
async function planFor(to: "on" | "off", key: HeldKey, doc: Row, accountId: string): Promise<Plan> {
  const tables = (isObject(doc["tables"]) ? doc["tables"] : {}) as Tables;
  const plan: Plan = { records: [], unreadable: 0 };
  await planRows(to, key, tables, plan);
  await planSettings(to, key, doc, accountId, plan);
  await planConnector(to, key, tables, plan);
  return plan;
}

const left = (to: "on" | "off", r: EncryptionReport): number => (to === "on" ? r.unsealed : r.sealed);
const sentence = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * Moves the account to `to` and finishes it. Starts the run when the account is not moving,
 * carries on when it is already moving that way, and refuses when it is moving the other way.
 * Never throws: it answers whether it finished, and if not, in a plain sentence, why.
 */
export async function encryptionRun(to: "on" | "off", deps: RunDeps): Promise<RunEnd> {
  const { api, key } = deps;
  if (deps.expectKeyRef !== undefined && deps.expectKeyRef !== key.keyRef) return { ok: false, said: NOT_YOURS };
  if ((deps.waiting?.() ?? 0) > 0) return { ok: false, said: WAITING };
  const moving: EncryptionState = to === "on" ? "turning_on" : "turning_off";
  try {
    let report = await api.report();
    if (report.state === (to === "on" ? "on" : "off")) {
      deps.setState?.(report.state);
      return { ok: true };
    }
    if (report.state !== moving) {
      if (report.state === "turning_on" || report.state === "turning_off") {
        return { ok: false, said: `It is part way through turning ${report.state === "turning_on" ? "on" : "off"}. That has to finish first.` };
      }
      report = await api.start(to);
    }
    deps.setState?.(report.state);

    const total = Math.max(1, left(to, report));
    const tell = (r: EncryptionReport): void => deps.progress?.({ done: Math.min(total, Math.max(0, total - left(to, r))), total });
    tell(report);

    const accountId = await api.accountId();
    for (let pass = 0; pass < PASSES; pass++) {
      const plan = await planFor(to, key, await api.exportAll(), accountId);
      for (let at = 0; at < plan.records.length; at += BATCH) {
        try {
          await api.batch(plan.records.slice(at, at + BATCH));
          tell(await api.report());
        } catch (error) {
          return { ok: false, said: `It stopped part way: ${sentence(error)} What was written stays as it is, and it can carry on.` };
        }
      }
      const finished = await api.finish();
      if (finished.done) {
        deps.progress?.({ done: total, total });
        deps.setState?.(to === "on" ? "on" : "off");
        if (to === "on") await deps.forget?.().catch(() => undefined);
        return { ok: true };
      }
      tell(finished.report);
      // Nothing this key could move, and the Worker still counts some: the key is not the account's.
      if (plan.records.length === 0) return { ok: false, said: plan.unreadable > 0 ? CLOSED_OFF : MOVED_ON };
    }
    return { ok: false, said: MOVED_ON };
  } catch (error) {
    return { ok: false, said: sentence(error) };
  }
}
