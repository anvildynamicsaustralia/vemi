/**
 * The app's side of full encryption: what an account that has the switch on sends and shows.
 *
 * With the switch on, the typed text of a write is sealed here, before the outbox sees it, so a
 * queued write holds only envelopes and no request body or address ever holds plaintext. A read
 * is opened here, field by field, after the Worker answers; the body as it came is kept for
 * `resources.ts` to compare. A field that cannot be opened (no key on this device, or one that
 * does not fit) is left alone where a locked field's own screen draws it, and is the word
 * "Locked" where a name or a title would show. With the switch off every function here hands
 * back what it was given, so the requests are byte for byte what they were.
 *
 * This module holds the account's state and a way to reach the device key. Nothing here sends
 * a write; it reads `/api/encryption` and nothing else.
 */
import {
  CHECKLIST_FIELD,
  ENCRYPTED_FIELDS,
  KINDS,
  LOCKABLE,
  type EncryptedKind,
  isEnvelopeShape,
  openRecord,
  sealRecord,
} from "@vemi/shared";
import { DEFAULT_LEVEL_NAMES } from "./levelWords.js";

export type EncryptionState = "off" | "turning_on" | "on" | "turning_off";

/** The key this device holds, as far as the app layer needs it. */
export interface HeldKey {
  readonly fieldKey: CryptoKey;
  readonly keyRef: string;
}
export type KeySource = () => Promise<HeldKey | null>;

/** What a field this device cannot read says where a name or a title would be. */
export const LOCKED_WORD = "Locked";

/** Thrown when text must be sealed and this device holds no key to do it with. */
export class NeedsKey extends Error {
  constructor() {
    super("This device does not hold the key yet, so this can't be saved here.");
    this.name = "NeedsKey";
  }
}

type Cells = Record<string, unknown>;

const STORED = "vemi:encryption:v1";
const STATES: readonly EncryptionState[] = ["off", "turning_on", "on", "turning_off"];

function storedState(): EncryptionState {
  try {
    const v = localStorage.getItem(STORED);
    return (STATES as readonly (string | null)[]).includes(v) ? (v as EncryptionState) : "off";
  } catch {
    return "off";
  }
}

// Kept so a start with no connection still seals what it queues.
let state: EncryptionState = storedState();
let source: KeySource = async () => null;
let epoch = 0;

/** Changes whenever the state or the key does, so an answer is opened again rather than reused. */
export const sealedEpoch = (): number => epoch;

export const encryptionState = (): EncryptionState => state;

/** Writes are sealed only while the switch is fully on. */
const sealing = (): boolean => state === "on";
/** Reads are opened whenever the account is anywhere but off. */
const opening = (): boolean => state !== "off";

export function setEncryptionState(next: EncryptionState): void {
  if (next === state) return;
  state = next;
  epoch += 1;
  try {
    localStorage.setItem(STORED, next);
  } catch {
    // The state is still held in memory.
  }
}

/** Where the device key comes from, or null for none. Called by whatever holds the vault. */
export function setKeySource(next: KeySource | null): void {
  source = next ?? (async () => null);
  epoch += 1;
}

/** The device key changed (opened, forgotten): answers are opened again. */
export function keyChanged(): void {
  epoch += 1;
}

/** The state forgotten, for signing out and for another account coming in. The key source belongs to the vault and stays. */
export function forgetSealed(): void {
  state = "off";
  epoch += 1;
  try {
    localStorage.removeItem(STORED);
  } catch {
    // Nothing to remove.
  }
}

/** Asks where the account is and holds the answer. With no answer, what was held stays. */
export async function refreshEncryption(doFetch: typeof fetch = fetch): Promise<EncryptionState> {
  try {
    const response = await doFetch("/api/encryption", { headers: { accept: "application/json" } });
    if (!response.ok) return state;
    const body = (await response.json()) as { state?: unknown };
    if ((STATES as readonly unknown[]).includes(body.state)) setEncryptionState(body.state as EncryptionState);
  } catch {
    // Offline or refused: the last state stays.
  }
  return state;
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const KIND_SET: ReadonlySet<string> = new Set<string>(KINDS);

const segmentsOf = (path: string): string[] => {
  const bare = path.split("?")[0] ?? "";
  const parts = bare.split("/").filter((p) => p !== "");
  return parts[0] === "api" ? parts.slice(1).map((p) => decodeURIComponent(p)) : [];
};

const LEVEL_FIELDS = {
  space: "levelSpace",
  project: "levelProject",
  milestone: "levelMilestone",
  task: "levelTask",
} as const;
type Level = keyof typeof LEVEL_FIELDS;
const LEVELS = Object.keys(LEVEL_FIELDS) as Level[];

const isObject = (v: unknown): v is Cells => typeof v === "object" && v !== null && !Array.isArray(v);

// ---------------------------------------------------------------------------
// Sealing what goes out
// ---------------------------------------------------------------------------

/** True when a listed field, or a checklist item, holds text that is not already an envelope. */
function hasPlain(kind: EncryptedKind, row: Cells): boolean {
  for (const field of ENCRYPTED_FIELDS[kind] as readonly string[]) {
    const v = row[field];
    if (typeof v === "string" && !isEnvelopeShape(v)) return true;
  }
  const list = row["checklist"];
  if (kind === "tasks" && Array.isArray(list)) {
    for (const item of list as unknown[]) {
      const text = isObject(item) ? item["text"] : undefined;
      if (typeof text === "string" && !isEnvelopeShape(text)) return true;
    }
  }
  return false;
}

async function sealRow(kind: EncryptedKind, row: Cells): Promise<Cells> {
  if (!hasPlain(kind, row)) return row;
  const key = await source();
  if (key === null) throw new NeedsKey();
  return (await sealRecord(key.fieldKey, key.keyRef, kind, row)).row;
}

async function sealAppearance(body: Cells): Promise<Cells> {
  const row: Cells = {};
  const names = body["levelNames"];
  if (isObject(names)) {
    for (const level of LEVELS) {
      const v = names[level];
      if (typeof v === "string") row[LEVEL_FIELDS[level]] = v;
    }
  }
  const stages = body["defaultStages"];
  if (Array.isArray(stages)) row["defaultStages"] = JSON.stringify(stages);
  if (Object.keys(row).length === 0) return body;
  const sealed = await sealRow("settings", row);
  const out: Cells = { ...body };
  if (isObject(names)) {
    const next: Cells = { ...names };
    for (const level of LEVELS) {
      if (typeof names[level] === "string") next[level] = sealed[LEVEL_FIELDS[level]];
    }
    out["levelNames"] = next;
  }
  if (Array.isArray(stages)) out["defaultStages"] = sealed["defaultStages"];
  return out;
}

/**
 * The body to send for a write to `path`: with the switch on, every typed text sealed and bound
 * to its record; otherwise the body itself. A saved filter that names no id is given one, since
 * its envelopes are bound to it. Throws `NeedsKey` when text must be sealed and no key is here.
 */
export async function sealOutgoing(path: string, body: Readonly<Cells>): Promise<Readonly<Cells>> {
  if (!sealing()) return body;
  const [first, second, third] = segmentsOf(path);
  if (first === "appearance" && second === undefined) return sealAppearance(body);
  if (first === "filters") {
    if (second === "dates") return body;
    if (second === undefined) {
      const id = typeof body["id"] === "string" ? body["id"] : crypto.randomUUID();
      return sealRow("savedFilters", { ...body, id });
    }
    const { id: _id, ...rest } = await sealRow("savedFilters", { ...body, id: second });
    return rest;
  }
  if (first === undefined || !KIND_SET.has(first) || !(first in ENCRYPTED_FIELDS)) return body;
  const kind = first as EncryptedKind;
  if (second === undefined) {
    const id = typeof body["id"] === "string" ? body["id"] : crypto.randomUUID();
    return sealRow(kind, { ...body, id });
  }
  if (third !== undefined) return body;
  const { id: _id, ...rest } = await sealRow(kind, { ...body, id: second });
  return rest;
}

// ---------------------------------------------------------------------------
// Opening what comes in
// ---------------------------------------------------------------------------

const lockableIn = (kind: EncryptedKind, field: string): boolean => {
  const names = (LOCKABLE as Readonly<Record<string, readonly string[]>>)[kind];
  return names !== undefined && names.includes(field);
};

/** With no key: every sealed name or title says Locked; a lockable field is left for its own screen. */
function lockedRow<T extends object>(kind: EncryptedKind, row: T): T {
  const out: Cells = { ...(row as Cells) };
  for (const field of ENCRYPTED_FIELDS[kind] as readonly string[]) {
    const v = out[field];
    if (typeof v === "string" && isEnvelopeShape(v) && !lockableIn(kind, field)) out[field] = LOCKED_WORD;
  }
  return out as T;
}

/** One row opened. A row that cannot be walked is returned as it is. */
async function openRow<T extends object>(kind: EncryptedKind, row: T, key: HeldKey | null): Promise<T> {
  if (!isObject(row) || typeof row["id"] !== "string") return row;
  if (key === null) return lockedRow(kind, row);
  try {
    const { row: opened, failed } = await openRecord(key.fieldKey, key.keyRef, kind, row);
    const out: Cells = { ...(opened as Cells) };
    for (const field of failed) {
      // A checklist keeps its envelopes: a whole list is written back when one item is ticked.
      if (field === CHECKLIST_FIELD || field === "checklist") continue;
      if (!lockableIn(kind, field) && typeof out[field] === "string") out[field] = LOCKED_WORD;
    }
    return out as T;
  } catch {
    return row;
  }
}

const rowsOf = <T extends object>(kind: EncryptedKind, rows: readonly T[], key: HeldKey | null): Promise<T[]> =>
  Promise.all(rows.map((r) => openRow(kind, r, key)));

const arrayOf = (v: unknown): readonly Cells[] => (Array.isArray(v) ? (v as Cells[]) : []);

/**
 * A task, and the blocker that may sit on it. `sourceId` is the task this answer is about when
 * the answer is a write to it: the next task of a finished repeat carries the finished task's
 * title envelope, which is bound to the finished task's id, so it is opened under that one.
 */
async function openTask<T extends object>(task: T, key: HeldKey | null, sourceId?: string): Promise<T> {
  const out: Cells = await openRow("tasks", task as Cells, key);
  if (isObject(out["blocker"])) out["blocker"] = await openRow("blockers", out["blocker"], key);
  const spawned = out["spawned"];
  if (isObject(spawned)) {
    const nextId = spawned["id"];
    if (sourceId === undefined || typeof nextId !== "string") out["spawned"] = await openTask(spawned, key);
    else out["spawned"] = { ...(await openTask({ ...spawned, id: sourceId }, key)), id: nextId };
  }
  return out as T;
}

const tasksOf = (rows: unknown, key: HeldKey | null): Promise<Cells[]> =>
  Promise.all(arrayOf(rows).map((t) => openTask(t, key)));

async function openTree(data: Cells, key: HeldKey | null): Promise<Cells> {
  const ventures = await Promise.all(arrayOf(data["ventures"]).map(async (v) => {
    const venture: Cells = await openRow("ventures", v, key);
    const [states, stages, tasks, projects] = await Promise.all([
      rowsOf("states", arrayOf(v["states"]), key),
      rowsOf("stages", arrayOf(v["stages"]), key),
      tasksOf(v["tasks"], key),
      Promise.all(arrayOf(v["projects"]).map(async (p) => {
        const project: Cells = await openRow("projects", p, key);
        const [milestones, ptasks] = await Promise.all([
          rowsOf("milestones", arrayOf(p["milestones"]), key),
          tasksOf(p["tasks"], key),
        ]);
        return { ...project, milestones, tasks: ptasks };
      })),
    ]);
    return { ...venture, states, stages, tasks, projects };
  }));
  return { ...data, ventures };
}

/** The field an archived item's label was made from. A link's label may be its address. */
const LABEL_FIELDS: Readonly<Record<string, readonly string[]>> = {
  ventures: ["name"], states: ["name"], stages: ["name"], projects: ["name"], milestones: ["name"],
  tasks: ["title"], blockers: ["reason"], notes: ["body"], decisions: ["title"], risks: ["title"],
  links: ["label", "url"], tags: ["name"],
};

async function openLabel(item: Cells, key: HeldKey | null): Promise<Cells> {
  const kind = item["kind"];
  const label = item["label"];
  const id = item["id"];
  if (typeof kind !== "string" || typeof label !== "string" || typeof id !== "string" || !isEnvelopeShape(label)) return item;
  const fields = LABEL_FIELDS[kind];
  if (fields === undefined) return item;
  if (key !== null) {
    for (const field of fields) {
      try {
        const { row, failed } = await openRecord(key.fieldKey, key.keyRef, kind as EncryptedKind, { id, [field]: label });
        if (!failed.includes(field)) return { ...item, label: (row as Cells)[field] };
      } catch {
        // Try the next field.
      }
    }
  }
  return { ...item, label: LOCKED_WORD };
}

async function openSettings(data: Cells, key: HeldKey | null): Promise<Cells> {
  const names = data["levelNames"];
  const stages = data["defaultStages"];
  const out: Cells = { ...data };
  const row: Cells = {};
  if (isObject(names)) for (const level of LEVELS) if (typeof names[level] === "string") row[LEVEL_FIELDS[level]] = names[level];
  if (typeof stages === "string") row["defaultStages"] = stages;
  const sealedText = (v: unknown): boolean => typeof v === "string" && isEnvelopeShape(v);
  if (!Object.values(row).some(sealedText)) return data;
  let opened: Cells = row;
  let failed: readonly string[] = Object.keys(row).filter((f) => sealedText(row[f]));
  if (key !== null) {
    try {
      const walked = await openRecord(key.fieldKey, key.keyRef, "settings", row);
      opened = walked.row;
      failed = walked.failed;
    } catch {
      // Everything sealed stays unread.
    }
  }
  if (isObject(names)) {
    const next: Cells = { ...names };
    for (const level of LEVELS) {
      const field = LEVEL_FIELDS[level];
      if (typeof names[level] !== "string") continue;
      next[level] = failed.includes(field) || sealedText(opened[field]) ? DEFAULT_LEVEL_NAMES[level] : opened[field];
    }
    out["levelNames"] = next;
  }
  if (typeof stages === "string") {
    let list: unknown = null;
    if (!failed.includes("defaultStages") && typeof opened["defaultStages"] === "string") {
      try {
        list = JSON.parse(opened["defaultStages"]);
      } catch {
        list = null;
      }
    }
    out["defaultStages"] = Array.isArray(list) ? list : null;
  }
  return out;
}

const byName = (a: Cells, b: Cells): number => {
  const x = typeof a["name"] === "string" ? a["name"] : "";
  const y = typeof b["name"] === "string" ? b["name"] : "";
  return x < y ? -1 : x > y ? 1 : 0;
};

/**
 * What the Worker answered for `path`, with every typed field opened. Shapes it does not know
 * (the export, search, the locked list, the key's calls) come back as they are. Never throws.
 */
export async function openAnswer<T>(path: string, data: T): Promise<T> {
  if (!opening() || (!isObject(data) && !Array.isArray(data))) return data;
  try {
    const key = await source();
    const [first, second, third] = segmentsOf(path);
    switch (first) {
      case "tree": return (await openTree(data as Cells, key)) as T;
      case "today": return { ...(data as Cells), tasks: await tasksOf((data as Cells)["tasks"], key) } as T;
      case "overview": return { ...(data as Cells), ventures: await rowsOf("ventures", arrayOf((data as Cells)["ventures"]), key) } as T;
      case "archived":
        return { ...(data as Cells), items: await Promise.all(arrayOf((data as Cells)["items"]).map((i) => openLabel(i, key))) } as T;
      case "appearance": return (await openSettings(data as Cells, key)) as T;
      case "filters": {
        if (second === "dates") {
          const d = data as Cells;
          const [before, week] = await Promise.all([tasksOf(d["before"], key), tasksOf(d["week"], key)]);
          return { ...d, before, week } as T;
        }
        if (second === undefined && !Array.isArray(data)) {
          return { ...(data as Cells), filters: await rowsOf("savedFilters", arrayOf((data as Cells)["filters"]), key) } as T;
        }
        return (await openRow("savedFilters", data as Cells, key)) as T;
      }
      default: break;
    }
    if (first === undefined || !KIND_SET.has(first) || !(first in ENCRYPTED_FIELDS)) return data;
    const kind = first as EncryptedKind;
    if (second === undefined && Array.isArray(data)) {
      const rows = kind === "tasks" ? await tasksOf(data, key) : await rowsOf(kind, data as Cells[], key);
      return (kind === "tags" ? [...rows].sort(byName) : rows) as T;
    }
    // One record: a read by id, a create's answer at the kind's own path, an edit, an archive.
    if ((second === undefined || third === undefined || third === "archive" || third === "unarchive") && !Array.isArray(data)) {
      return (kind === "tasks"
        ? await openTask(data as Cells, key, second)
        : await openRow(kind, data as Cells, key)) as T;
    }
    return data;
  } catch {
    return data;
  }
}
