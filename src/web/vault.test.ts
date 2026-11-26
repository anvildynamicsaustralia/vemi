import { describe, expect, it } from "vitest";
import { type Bytes, keysFrom, lockBinding, seal } from "@vemi/shared";
import type { KeyState } from "./api.js";
import { type DeviceKey, memoryShelf } from "./deviceKey.js";
import { createVault } from "./vault.js";

const ACCOUNT = "a@example.com";
const none: KeyState = { keyRef: null, keyCheck: null, wraps: [] };
const made: KeyState = { keyRef: "ref", keyCheck: "check", wraps: [] };

async function held(fill: number): Promise<DeviceKey> {
  const keys = await keysFrom(new Uint8Array(32).fill(fill) as Bytes);
  return { fieldKey: keys.fieldKey, keyRef: keys.keyRef, deviceId: "dev" };
}

function vaultWith(key: DeviceKey | null, state: KeyState = made) {
  const shelf = memoryShelf();
  if (key !== null) shelf.entries.set(ACCOUNT, key);
  const requests: unknown[] = [];
  const vault = createVault(ACCOUNT, { shelf, keysNow: async () => { requests.push("keys"); return state; } });
  return { vault, shelf, requests };
}

describe("the vault's state", () => {
  it("is open when this device holds the key, without asking the Worker", async () => {
    const { vault, requests } = vaultWith(await held(1));
    expect(await vault.state()).toBe("open");
    expect(requests).toEqual([]);
  });
  it("is closed when a key exists and this device does not hold it, and none when there is no key", async () => {
    expect(await vaultWith(null).vault.state()).toBe("closed");
    expect(await vaultWith(null, none).vault.state()).toBe("none");
  });
  it("is unknown when the Worker cannot be reached", async () => {
    const vault = createVault(ACCOUNT, { shelf: memoryShelf(), keysNow: () => Promise.reject(new Error("offline")) });
    expect(await vault.state()).toBe("unknown");
  });
  it("opens in memory for a browser that cannot keep the key", async () => {
    const { vault } = vaultWith(null);
    expect(await vault.state()).toBe("closed");
    vault.hold(await held(1));
    expect(await vault.state()).toBe("open");
  });
});

describe("sealing and opening a field", () => {
  it("round trips, and the envelope shows no part of the text", async () => {
    const { vault } = vaultWith(await held(1));
    const sealed = await vault.sealField("notes", "n1", "body", "the safe code is 4821");
    expect(sealed).not.toBeNull();
    expect(sealed).not.toContain("4821");
    expect(await vault.openField("notes", "n1", "body", sealed ?? "")).toEqual({ status: "open", text: "the safe code is 4821" });
  });
  it("seals nothing without a key", async () => {
    expect(await vaultWith(null).vault.sealField("tasks", "t1", "body", "x")).toBeNull();
  });
  it("answers locked with no key, and locked for an envelope of another key ref", async () => {
    const mine = await held(1);
    const theirs = await held(2);
    const foreign = await seal(theirs.fieldKey, theirs.keyRef, "hello", lockBinding("notes", "n1", "body"));
    expect(await vaultWith(null).vault.openField("notes", "n1", "body", foreign)).toEqual({ status: "locked" });
    expect(await vaultWith(mine).vault.openField("notes", "n1", "body", foreign)).toEqual({ status: "locked" });
  });
  it("answers damaged for a field moved to another record or field, or with a flipped byte", async () => {
    const { vault } = vaultWith(await held(1));
    const sealed = (await vault.sealField("notes", "n1", "body", "hello")) ?? "";
    expect(await vault.openField("notes", "n2", "body", sealed)).toEqual({ status: "damaged" });
    expect(await vault.openField("tasks", "n1", "body", sealed)).toEqual({ status: "damaged" });
    const last = sealed.slice(-1) === "A" ? "B" : "A";
    expect(await vault.openField("notes", "n1", "body", sealed.slice(0, -1) + last)).toEqual({ status: "damaged" });
  });
  it("hands plain text back as open and never throws on odd input", async () => {
    const { vault } = vaultWith(await held(1));
    expect(await vault.openField("notes", "n1", "body", "v1.2 beta")).toEqual({ status: "open", text: "v1.2 beta" });
    expect(await vault.openField("notes", "n1", "body", "")).toEqual({ status: "open", text: "" });
  });
  it("makes a different envelope each time", async () => {
    const { vault } = vaultWith(await held(1));
    expect(await vault.sealField("notes", "n1", "body", "same")).not.toBe(await vault.sealField("notes", "n1", "body", "same"));
  });
});
