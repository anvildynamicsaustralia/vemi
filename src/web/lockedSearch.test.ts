import { describe, expect, it } from "vitest";
import { type Bytes, keysFrom, lockBinding, seal } from "@vemi/shared";
import type { KeyState, LockedField } from "./api.js";
import { type DeviceKey, memoryShelf } from "./deviceKey.js";
import { isLockedHit, lockedSearch, mergeLocked } from "./lockedSearch.js";
import { createVault } from "./vault.js";

const ACCOUNT = "a@example.com";
const made: KeyState = { keyRef: "ref", keyCheck: "check", wraps: [] };

async function key(fill: number): Promise<DeviceKey> {
  const keys = await keysFrom(new Uint8Array(fill === 0 ? 32 : 32).fill(fill) as Bytes);
  return { fieldKey: keys.fieldKey, keyRef: keys.keyRef, deviceId: "dev" };
}

async function field(k: DeviceKey, kind: "tasks" | "notes" | "projects", id: string, name: string, text: string): Promise<LockedField> {
  const f = name as never;
  const value = await seal(k.fieldKey, k.keyRef, text, lockBinding(kind, id, f));
  return { kind, id, field: name, value, ventureId: "v1", projectId: kind === "projects" ? id : "p1", taskId: kind === "tasks" ? id : null };
}

function vaultHolding(k: DeviceKey | null) {
  const shelf = memoryShelf();
  if (k !== null) shelf.entries.set(ACCOUNT, k);
  return createVault(ACCOUNT, { shelf, keysNow: async () => made });
}

describe("lockedSearch", () => {
  it("finds a locked task body only after the key is open", async () => {
    const k = await key(1);
    const fields = [await field(k, "tasks", "t1", "body", "ring the Locksmith about the safe")];
    const vault = vaultHolding(null);
    expect(await lockedSearch("locksmith", fields, vault)).toEqual([]);
    vault.hold(k);
    const hits = await lockedSearch("locksmith", fields, vault, (_kind, id) => (id === "t1" ? "Sort the safe" : undefined));
    expect(hits).toEqual([
      { kind: "task", id: "t1", ventureId: "v1", projectId: "p1", taskId: "t1", text: "Sort the safe", locked: true },
    ]);
  });

  it("answers nothing, for any word, with the key closed", async () => {
    const k = await key(1);
    const fields = [await field(k, "notes", "n1", "body", "private thing")];
    const vault = vaultHolding(null);
    expect(await lockedSearch("private", fields, vault)).toEqual([]);
    expect(await lockedSearch("zzz", fields, vault)).toEqual([]);
  });

  it("skips a field sealed with another key and one that does not match", async () => {
    const k = await key(1);
    const other = await key(2);
    const fields = [
      await field(other, "notes", "n1", "body", "alpha from elsewhere"),
      await field(k, "notes", "n2", "body", "beta here"),
    ];
    const vault = vaultHolding(k);
    expect(await lockedSearch("alpha", fields, vault)).toEqual([]);
    expect((await lockedSearch("BETA", fields, vault)).map((h) => h.id)).toEqual(["n2"]);
  });

  it("lists a note by its body cut as the server cuts it, and one hit per record", async () => {
    const k = await key(1);
    const long = `needle ${"x".repeat(200)}`;
    const fields = [
      await field(k, "notes", "n1", "body", long),
      await field(k, "projects", "p9", "whoFor", "needle people"),
      await field(k, "projects", "p9", "doneLooks", "needle done"),
    ];
    const hits = await lockedSearch("needle", fields, vaultHolding(k), (_kind, id) => (id === "p9" ? "Nine" : undefined));
    expect(hits.map((h) => [h.kind, h.id, h.text.length])).toEqual([["project", "p9", 4], ["note", "n1", 120]]);
    expect(hits.every(isLockedHit)).toBe(true);
  });

  it("answers nothing for an empty word", async () => {
    const k = await key(1);
    expect(await lockedSearch("  ", [await field(k, "notes", "n1", "body", "x")], vaultHolding(k))).toEqual([]);
  });
});

describe("mergeLocked", () => {
  it("adds locked hits after the server's of the same kind and never doubles a record", () => {
    const plain = [{ kind: "task" as const, id: "t1", ventureId: "v", projectId: null, taskId: "t1", text: "A" }];
    const locked = [
      { ...plain[0]!, locked: true as const },
      { kind: "task" as const, id: "t2", ventureId: "v", projectId: null, taskId: "t2", text: "B", locked: true as const },
      { kind: "project" as const, id: "p1", ventureId: "v", projectId: "p1", taskId: null, text: "P", locked: true as const },
    ];
    expect(mergeLocked(plain, locked).map((h) => h.id)).toEqual(["p1", "t1", "t2"]);
    expect(isLockedHit(mergeLocked(plain, locked)[2]!)).toBe(true);
  });
});
