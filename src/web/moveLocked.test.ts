import { describe, expect, it } from "vitest";
import {
  type Bytes, formatRecoveryKey, keysFrom, lockBinding, makeRecoveryKey, open, recoveryWrappingKey, seal, wrapKey,
} from "@vemi/shared";
import {
  PASSKEY_LINE, clearFinishing, exportFrom, finishLocked, finishingMarked, idsFromCopy, leftSentence, lockedHeld, markFinishing, needsKey, openBeforeSend,
  passkeyLine, pendingFinishing, readableCells,
} from "./moveLocked.js";
import type { ResealPatch } from "./restoreReseal.js";

const SECRET = "the safe code is 4821";
const TYPED = "Mend the gate";

async function exported(opts: { lockedRow: boolean } = { lockedRow: true }) {
  const accountKey = new Uint8Array(32).fill(0x31) as Bytes;
  const keys = await keysFrom(accountKey);
  const recoveryBytes = makeRecoveryKey();
  const wrapped = await wrapKey(await recoveryWrappingKey(recoveryBytes), accountKey, "recovery", keys.keyRef);
  const recoveryKey = await formatRecoveryKey(recoveryBytes);
  const body = opts.lockedRow ? await seal(keys.fieldKey, keys.keyRef, SECRET, lockBinding("notes", "note-1", "body")) : "plain words";
  const title = await seal(keys.fieldKey, keys.keyRef, TYPED, { record: "task-1", field: "title" });
  const key_wrap = [{
    id: "k-recovery", key_ref: keys.keyRef, key_check: keys.keyCheck, kind: "recovery", label: "Recovery", device_id: null,
    credential_id: null, salt: null, iterations: null, wrapped, created_at: "2026-11-19T00:00:00Z", archived_at: null,
  }];
  const document = {
    format: "vemi-export", version: 2,
    tables: { note: [{ id: "note-1", body }], task: [{ id: "task-1", title }], key_wrap },
  };
  return { document, keys, recoveryKey, body, title };
}

/** What a restore leaves on the new copy: every row under a new id, the cells byte for byte. */
const restored = (document: { tables: Record<string, Record<string, unknown>[]> }) => ({
  tables: Object.fromEntries(Object.entries(document.tables).map(([t, rows]) => [t, rows.map((r) => ({ ...r, id: `new-${String(r["id"])}` }))])),
});

describe("a document with locked content", () => {
  it("is told apart by what it holds, and the passkey line shows only for a locked row", async () => {
    const full = lockedHeld((await exported()).document);
    expect(full.locked).toBe(1);
    expect(needsKey(full)).toBe(true);
    expect(passkeyLine(full)).toBe(PASSKEY_LINE);

    const typedOnly = lockedHeld((await exported({ lockedRow: false })).document);
    expect(typedOnly.locked).toBe(0);
    expect(needsKey(typedOnly)).toBe(true);
    expect(passkeyLine(typedOnly)).toBeNull();

    expect(needsKey(lockedHeld({ tables: { note: [{ id: "n", body: "plain" }] } }))).toBe(false);
    expect(PASSKEY_LINE).not.toContain(String.fromCharCode(0x2014));
  });

  it("opens the key by the file's own way in before anything is sent, and a wrong one stops there", async () => {
    const { document, recoveryKey, keys } = await exported();
    const opened = await openBeforeSend("a@example.com", document, { kind: "recovery", recoveryKey });
    expect(opened.keyRef).toBe(keys.keyRef);
    await expect(openBeforeSend("a@example.com", document, { kind: "recovery", recoveryKey: "AAAA-AAAA-AAAA" })).rejects.toThrow();
  });

  it("refuses a file that holds envelopes but no key rows", async () => {
    const { document } = await exported();
    const bare = { ...document, tables: { ...document.tables, key_wrap: [] } };
    await expect(openBeforeSend("a@example.com", bare, { kind: "recovery", recoveryKey: "x" })).rejects.toThrow("does not hold a key");
  });

  it("holds no readable text of a locked field in the file that is sent", async () => {
    const { document } = await exported();
    expect(readableCells(document, [SECRET, TYPED])).toEqual([]);
    expect(readableCells({ tables: { note: [{ id: "n", body: SECRET }] } }, [SECRET])).toEqual(["note.body"]);
  });
});

describe("the finishing pass", () => {
  it("finds the ids from the new copy itself, then moves each envelope so it opens at its new id", async () => {
    const { document, keys } = await exported();
    const copy = restored(document as never);
    const ids = idsFromCopy(document, copy);
    expect(ids).toEqual({ "note-1": "new-note-1", "task-1": "new-task-1" });

    const saved: ResealPatch[] = [];
    const out = await finishLocked(document, ids, keys, { save: async (p) => { saved.push(p); }, replaceFilter: async () => {} });
    expect(out.resealed).toBe(2);
    expect(out.left).toBe(0);
    expect(out.said).toBeNull();
    const note = saved.find((p) => p.kind === "notes")?.fields["body"] as string;
    expect(await open(keys.fieldKey, note, { ...lockBinding("notes", "new-note-1", "body"), keyRef: keys.keyRef })).toBe(SECRET);
    expect(readableCells({ tables: { note: [{ id: "x", body: note }] } }, [SECRET])).toEqual([]);
  });

  it("counts a cell that opens under neither id, leaves it, and says so in one sentence", async () => {
    const { document, keys } = await exported();
    const other = await keysFrom(new Uint8Array(32).fill(0x77) as Bytes);
    const foreign = await seal(other.fieldKey, other.keyRef, "not ours", lockBinding("notes", "note-2", "body"));
    const mixed = { ...document, tables: { ...document.tables, note: [...document.tables.note, { id: "note-2", body: foreign }] } };
    const saved: ResealPatch[] = [];
    const out = await finishLocked(mixed, { "note-1": "n1", "note-2": "n2", "task-1": "t1" }, keys, {
      save: async (p) => { saved.push(p); }, replaceFilter: async () => {},
    });
    expect(out.left).toBe(1);
    expect(out.said).toBe(leftSentence(1));
    expect(saved.some((p) => p.id === "n2")).toBe(false);
  });

  it("is safe to run again: a cell already at its new id is not touched", async () => {
    const { document, keys } = await exported();
    const ids = { "note-1": "n1", "task-1": "t1" };
    const saved: ResealPatch[] = [];
    const steps = { save: async (p: ResealPatch) => { saved.push(p); }, replaceFilter: async () => {} };
    await finishLocked(document, ids, keys, steps);
    const after = {
      ...document,
      tables: {
        ...document.tables,
        note: [{ id: "note-1", body: (saved.find((p) => p.kind === "notes")?.fields["body"]) as string }],
      },
    };
    const again: ResealPatch[] = [];
    await finishLocked(after, { "note-1": "n1" }, keys, { save: async (p) => { again.push(p); }, replaceFilter: async () => {} });
    expect(again).toEqual([]);
  });

  it("says nothing for none left and pluralises for many", () => {
    expect(leftSentence(0)).toBeNull();
    expect(leftSentence(3)).toContain("3 locked items");
  });
});

describe("resuming", () => {
  it("keeps the ids only, and reads them back or answers null", () => {
    const shelf = new Map<string, string>();
    const store = { setItem: (k: string, v: string) => void shelf.set(k, v), getItem: (k: string) => shelf.get(k) ?? null, removeItem: (k: string) => void shelf.delete(k) };
    expect(pendingFinishing(store)).toBeNull();
    markFinishing({ a: "b" }, store);
    expect([...shelf.values()].join("")).not.toContain("key");
    expect(pendingFinishing(store)).toEqual({ a: "b" });
    clearFinishing(store);
    expect(pendingFinishing(store)).toBeNull();
    store.setItem("vemi:move:finishing", "not json");
    expect(pendingFinishing(store)).toBeNull();
  });
});

describe("finishing marks", () => {
  it("reads the mark a move leaves in the address, and only that", () => {
    expect(finishingMarked("?finishing=1")).toBe(true);
    expect(finishingMarked("")).toBe(false);
    expect(finishingMarked("?finishing=0")).toBe(false);
  });

  it("takes only an export from a file's text", () => {
    expect(exportFrom('{"format":"vemi-export","tables":{}}')).not.toBeNull();
    expect(exportFrom('{"format":"other"}')).toBeNull();
    expect(exportFrom("nope")).toBeNull();
  });
});
