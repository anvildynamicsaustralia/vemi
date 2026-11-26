import { describe, expect, it } from "vitest";
import { type DeviceKey, type KeyShelf, deviceKey, forgetDeviceKey, keepDeviceKey, memoryShelf } from "./deviceKey.js";

async function aKey(): Promise<DeviceKey> {
  const fieldKey = await crypto.subtle.importKey("raw", new Uint8Array(32), "AES-GCM", false, ["encrypt", "decrypt"]);
  return { fieldKey, keyRef: "ref1", deviceId: "dev1" };
}

describe("the key kept on this device", () => {
  it("keeps one entry per account and gives it back", async () => {
    const shelf = memoryShelf();
    const key = await aKey();
    expect(await keepDeviceKey("a@example.com", key, shelf)).toBe(true);
    expect(await deviceKey("a@example.com", shelf)).toEqual(key);
    expect(await deviceKey("b@example.com", shelf)).toBeNull();
  });

  it("forgets one account and leaves the other", async () => {
    const shelf = memoryShelf();
    await keepDeviceKey("a@example.com", await aKey(), shelf);
    await keepDeviceKey("b@example.com", await aKey(), shelf);
    await forgetDeviceKey("a@example.com", shelf);
    expect(await deviceKey("a@example.com", shelf)).toBeNull();
    expect(await deviceKey("b@example.com", shelf)).not.toBeNull();
  });

  it("never throws when the storage does", async () => {
    const broken: KeyShelf = {
      get: () => Promise.reject(new Error("blocked")),
      put: () => Promise.reject(new Error("blocked")),
      remove: () => Promise.reject(new Error("blocked")),
    };
    expect(await deviceKey("a@example.com", broken)).toBeNull();
    expect(await keepDeviceKey("a@example.com", await aKey(), broken)).toBe(false);
    await expect(forgetDeviceKey("a@example.com", broken)).resolves.toBeUndefined();
  });

  it("reads an entry of the wrong shape as nothing", async () => {
    const shelf: KeyShelf = { get: async () => ({ keyRef: 3 }), put: async () => undefined, remove: async () => undefined };
    expect(await deviceKey("a@example.com", shelf)).toBeNull();
  });

  it("keeps a field key that cannot be read out", async () => {
    const key = await aKey();
    await expect(crypto.subtle.exportKey("raw", key.fieldKey)).rejects.toThrow();
  });
});
