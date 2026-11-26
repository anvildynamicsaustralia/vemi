import { describe, expect, it } from "vitest";
import {
  type Bytes,
  keysFrom,
  lockBinding,
  makeRecoveryKey,
  formatRecoveryKey,
  recoveryWrappingKey,
  seal,
  wrapKey,
} from "@vemi/shared";
import type { RestoreCounts } from "./api.js";
import { memoryShelf } from "./deviceKey.js";
import { KeyWayError } from "./keyWays.js";
import { createVault } from "./vault.js";
import { fileKeyState, openKey, restoreWithLocked } from "./restoreLocked.js";

const ACCOUNT = "a@example.com";
const SECRET = "the safe code is 4821";

/** An account's export holding one locked note and the key rows that open it. */
async function exported() {
  const accountKey = new Uint8Array(32).fill(0x31) as Bytes;
  const keys = await keysFrom(accountKey);
  const recoveryBytes = makeRecoveryKey();
  const wrapped = await wrapKey(await recoveryWrappingKey(recoveryBytes), accountKey, "recovery", keys.keyRef);
  const recoveryKey = await formatRecoveryKey(recoveryBytes);
  const sealed = await seal(keys.fieldKey, keys.keyRef, SECRET, lockBinding("notes", "note-1", "body"));
  const keyRow = (id: string, kind: string, extra: Record<string, unknown>) => ({
    id, key_ref: keys.keyRef, key_check: keys.keyCheck, kind, label: kind, device_id: null, credential_id: null,
    salt: null, iterations: null, wrapped: null, created_at: "2026-11-19T00:00:00Z", archived_at: null, ...extra,
  });
  const document = {
    format: "vemi-export", version: 2, exportedAt: "2026-11-19T00:00:00Z", about: "", settings: {},
    tables: {
      note: [{ id: "note-1", project_id: "p1", body: sealed }, { id: "note-2", project_id: "p1", body: "plain words" }],
      key_wrap: [
        keyRow("k-recovery", "recovery", { wrapped }),
        keyRow("k-device", "device", { label: "Chrome on Windows" }),
        keyRow("k-old", "recovery", { wrapped, archived_at: "2026-11-01T00:00:00Z" }),
      ],
    },
  };
  return { document, keys, recoveryKey, sealed };
}

/** A fresh account's Worker, as far as a restore goes: new ids for every row, and the list of sealed fields. */
function freshWorker() {
  const notes = new Map<string, string>();
  const calls: string[] = [];
  return {
    notes,
    calls,
    restore: async (document: Readonly<Record<string, unknown>>): Promise<RestoreCounts> => {
      calls.push("restore");
      const tables = document["tables"] as Record<string, Record<string, string>[]>;
      const locked: { kind: "notes"; field: string; from: string; to: string }[] = [];
      for (const row of tables["note"] ?? []) {
        const to = `new-${row["id"]}`;
        notes.set(to, row["body"] ?? "");
        if (row["body"]?.startsWith("v1.")) locked.push({ kind: "notes", field: "body", from: row["id"] ?? "", to });
      }
      return { restored: true, counts: { note: notes.size }, locked };
    },
    save: async (kind: string, id: string, field: string, value: string): Promise<void> => {
      calls.push(`save ${kind} ${id} ${field}`);
      notes.set(id, value);
    },
  };
}

describe("the file's own ways in", () => {
  it("reads the live key rows from the file and leaves out an archived one", async () => {
    const { document, keys } = await exported();
    const state = fileKeyState(document);
    expect(state?.keyRef).toBe(keys.keyRef);
    expect(state?.keyCheck).toBe(keys.keyCheck);
    expect(state?.wraps.map((w) => w.id)).toEqual(["k-recovery", "k-device"]);
  });
  it("answers null for a file with no key rows", () => {
    expect(fileKeyState({ tables: { note: [] } })).toBeNull();
  });
  it("opens the file's key with its recovery key, and refuses a wrong one without a request", async () => {
    const { document, keys, recoveryKey } = await exported();
    const state = fileKeyState(document);
    if (state === null) throw new Error("no state");
    const key = await openKey(ACCOUNT, state, { kind: "recovery", recoveryKey });
    expect(key.keyRef).toBe(keys.keyRef);
    const wrong = await formatRecoveryKey(makeRecoveryKey());
    await expect(openKey(ACCOUNT, state, { kind: "recovery", recoveryKey: wrong })).rejects.toBeInstanceOf(KeyWayError);
  });
});

describe("restoring a file with a locked note", () => {
  it("reseals the note to its new id, rejoins, and the restored copy opens it", async () => {
    const { document, recoveryKey } = await exported();
    const state = fileKeyState(document);
    if (state === null) throw new Error("no state");
    const key = await openKey(ACCOUNT, state, { kind: "recovery", recoveryKey });
    const worker = freshWorker();
    const joined: string[] = [];
    const done = await restoreWithLocked(document, key, {
      restore: worker.restore,
      save: worker.save,
      rejoin: async (held) => { worker.calls.push("rejoin"); joined.push(held.keyRef); },
    });
    expect(done.resealed).toBe(1);
    expect(done.left).toBe(0);
    // Reseal and save come before rejoin, and rejoin is last.
    expect(worker.calls).toEqual(["restore", "save notes new-note-1 body", "rejoin"]);
    expect(joined).toEqual([key.keyRef]);
    // The restored copy opens the note under its new id, and the plain one is as it was.
    const shelf = memoryShelf();
    shelf.entries.set(ACCOUNT, { fieldKey: key.fieldKey, keyRef: key.keyRef, deviceId: "d" });
    const vault = createVault(ACCOUNT, { shelf, keysNow: async () => ({ keyRef: key.keyRef, keyCheck: "c", wraps: [] }) });
    expect(await vault.openField("notes", "new-note-1", "body", worker.notes.get("new-note-1") ?? "")).toEqual({ status: "open", text: SECRET });
    expect(worker.notes.get("new-note-2")).toBe("plain words");
    // The envelope the file held is bound to the old id and does not open at the new one.
    expect(await vault.openField("notes", "new-note-1", "body", document.tables.note[0]?.body ?? "")).toEqual({ status: "damaged" });
  });

  it("changes nothing when the way in is wrong", async () => {
    const { document } = await exported();
    const state = fileKeyState(document);
    if (state === null) throw new Error("no state");
    const worker = freshWorker();
    const wrong = await formatRecoveryKey(makeRecoveryKey());
    const attempt = async () => {
      const key = await openKey(ACCOUNT, state, { kind: "recovery", recoveryKey: wrong });
      await restoreWithLocked(document, key, { restore: worker.restore, save: worker.save, rejoin: async () => undefined });
    };
    await expect(attempt()).rejects.toBeInstanceOf(KeyWayError);
    expect(worker.calls).toEqual([]);
    expect(worker.notes.size).toBe(0);
  });

  it("counts a field it cannot open as left, and still rejoins", async () => {
    const { document, recoveryKey } = await exported();
    const state = fileKeyState(document);
    if (state === null) throw new Error("no state");
    const key = await openKey(ACCOUNT, state, { kind: "recovery", recoveryKey });
    const other = await keysFrom(new Uint8Array(32).fill(0x55) as Bytes);
    const foreign = await seal(other.fieldKey, other.keyRef, "x", lockBinding("notes", "note-2", "body"));
    const tables = document.tables as unknown as { note: { id: string; body: string }[] };
    const changed = { ...document, tables: { ...document.tables, note: [tables.note[0], { id: "note-2", project_id: "p1", body: foreign }] } };
    const worker = freshWorker();
    const done = await restoreWithLocked(changed, key, { restore: worker.restore, save: worker.save, rejoin: async () => { worker.calls.push("rejoin"); } });
    expect(done).toMatchObject({ resealed: 1, left: 1 });
    expect(worker.calls.at(-1)).toBe("rejoin");
  });
});
