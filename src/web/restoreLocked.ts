/**
 * Restoring a file that holds locked fields. The file carries its own key rows, so one of the
 * file's own ways in opens its key here before anything is replaced. After the Worker has
 * restored, each sealed field is resealed to the new id of its record and saved, and only then
 * does this device take a fresh row for the key. Nothing here sends a key or a text to the Worker.
 */
import { type LockableField, type LockableKind, isSealed, lockBinding, makeAccountKey, reseal } from "@vemi/shared";
import { type KeyApi, type KeyRow, type KeyState, type RestoreCounts, type RestoredLock } from "./api.js";
import { type DeviceKey, memoryShelf } from "./deviceKey.js";
import { EXPORT_COLUMNS } from "./exportLocked.js";
import { type OpenWay, type Passkeys, KeyWayError, browserDeps, keyWays } from "./keyWays.js";

type Row = Record<string, unknown>;

const text = (v: unknown): string | null => (typeof v === "string" ? v : null);

/** The key rows a file holds, as the Worker would list them, or null when it holds none. */
export function fileKeyState(document: Readonly<Record<string, unknown>>): KeyState | null {
  const tables = document["tables"];
  if (typeof tables !== "object" || tables === null) return null;
  const rows = ((tables as Record<string, unknown>)["key_wrap"] ?? []) as Row[];
  const live = Array.isArray(rows) ? rows.filter((r) => r["archived_at"] == null && text(r["key_ref"]) !== null) : [];
  const first = live[0];
  if (first === undefined) return null;
  const keyRef = text(first["key_ref"]);
  const same = live.filter((r) => r["key_ref"] === keyRef);
  const keyCheck = same.map((r) => text(r["key_check"])).find((c) => c !== null) ?? null;
  const wraps: KeyRow[] = same.map((r) => ({
    id: text(r["id"]) ?? "",
    kind: r["kind"] as KeyRow["kind"],
    label: text(r["label"]) ?? "",
    deviceId: text(r["device_id"]),
    credentialId: text(r["credential_id"]),
    salt: text(r["salt"]),
    iterations: typeof r["iterations"] === "number" ? r["iterations"] : null,
    wrapped: text(r["wrapped"]),
    createdAt: text(r["created_at"]) ?? "",
  }));
  return { keyRef, keyCheck, wraps };
}

/**
 * The field key one way in opens from `state` (the file's rows, or the Worker's). The same
 * checks as opening the key for real, against rows handed in, with nothing kept and nothing
 * sent: the stand-in Worker answers only with those rows.
 */
export async function openKey(
  account: string,
  state: KeyState,
  way: OpenWay,
  passkeys: Passkeys = browserDeps().passkeys,
): Promise<Pick<DeviceKey, "fieldKey" | "keyRef">> {
  const refuse = (): never => { throw new KeyWayError("none", "This can't be opened here."); };
  const api: KeyApi = {
    keysNow: async () => state,
    addKeys: async () => state,
    archiveKey: async () => state,
    replaceRecovery: refuse,
    startAgain: refuse,
    openPairing: refuse,
    fillPairing: refuse,
    readPairing: refuse,
  };
  const opened = await keyWays(account, {
    api, shelf: memoryShelf(), passkeys, label: "File", makeKey: makeAccountKey, newId: () => crypto.randomUUID(),
  }).openWith(way);
  return { fieldKey: opened.fieldKey, keyRef: opened.keyRef };
}

export interface RestoreSteps {
  /** Replaces everything with the file and answers which sealed fields moved. */
  restore(document: Readonly<Record<string, unknown>>): Promise<RestoreCounts>;
  /** Saves one resealed field on its record. */
  save(kind: LockableKind, id: string, field: string, value: string): Promise<void>;
  /** A fresh device row for the key this device now holds. */
  rejoin(key: Pick<DeviceKey, "fieldKey" | "keyRef">): Promise<unknown>;
}

/** The envelope a file held for a record's field, or null. */
function held(document: Readonly<Record<string, unknown>>, lock: RestoredLock): string | null {
  const spec = EXPORT_COLUMNS[lock.kind];
  const columns = spec.columns as Record<string, string>;
  const column = columns[lock.field];
  const tables = document["tables"] as Record<string, Row[]> | undefined;
  const row = tables?.[spec.table]?.find((r) => r["id"] === lock.from);
  const value = column === undefined ? null : text(row?.[column]);
  return value !== null && isSealed(value) ? value : null;
}

/**
 * Restores, reseals each field the answer lists to its new id, saves it, then rejoins. A field
 * this key cannot open is counted in `left` and stays as the file had it. Call after `openKey`
 * has worked: a wrong way in never reaches this.
 */
export async function restoreWithLocked(
  document: Readonly<Record<string, unknown>>,
  key: Pick<DeviceKey, "fieldKey" | "keyRef">,
  steps: RestoreSteps,
): Promise<{ readonly counts: Readonly<Record<string, number>>; readonly resealed: number; readonly left: number }> {
  const answer = await steps.restore(document);
  const list: readonly RestoredLock[] = Array.isArray(answer.locked) ? answer.locked : [];
  let resealed = 0;
  let left = 0;
  for (const lock of list) {
    const envelope = held(document, lock);
    if (envelope === null) { left++; continue; }
    const field = lock.field as LockableField<typeof lock.kind>;
    let moved: string;
    try {
      moved = await reseal(key.fieldKey, envelope, lockBinding(lock.kind, lock.from, field), lockBinding(lock.kind, lock.to, field));
    } catch {
      left++;
      continue;
    }
    // A save that fails is not swallowed: the person is told, and the key is not rejoined.
    await steps.save(lock.kind, lock.to, lock.field, moved);
    resealed++;
  }
  await steps.rejoin(key);
  return { counts: answer.counts, resealed, left };
}
