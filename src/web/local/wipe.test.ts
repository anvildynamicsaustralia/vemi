import { describe, expect, it, vi } from "vitest";
import { OPFS_DIRECTORY } from "../../local/opfsDirectory.js";
import { LOCAL_KEY_NAME } from "./mode.js";
import { memoryShelf, type DeviceKey } from "../deviceKey.js";
import { DEVICE_DIRECTORY, removeLocalKey, wipeDevice, type WipeDeps } from "./wipe.js";
import { namespaced, type StorageLike } from "./storage.js";

function memory(): StorageLike {
  const data = new Map<string, string>();
  return {
    get length() { return data.size; },
    key: (i) => [...data.keys()][i] ?? null,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
    removeItem: (k) => void data.delete(k),
    clear: () => data.clear(),
  };
}

function rig() {
  const backing = memory();
  const mine = namespaced(backing);
  mine.setItem("vemi:outbox:v1", "x");
  backing.setItem("other-app", "keep");
  const session = memory();
  session.setItem("a", "b");
  const log: string[] = [];
  const deps: WipeDeps = {
    closeDatabase: vi.fn(async () => { log.push("close"); }),
    removeDirectory: vi.fn(async (name: string) => { log.push(`remove ${name}`); }),
    deleteKeys: vi.fn(async () => { log.push("keys"); }),
    local: mine,
    session,
  };
  return { deps, backing, session, log };
}

describe("wipeDevice", () => {
  it("names the directory the database worker opens", () => {
    expect(DEVICE_DIRECTORY).toBe(OPFS_DIRECTORY);
  });

  it("empties the database, the saved keys and the session, and says so", async () => {
    const { deps, backing, session, log } = rig();
    const out = await wipeDevice(deps);
    expect(out.ok).toBe(true);
    expect(log).toEqual(["close", `remove ${DEVICE_DIRECTORY}`, "keys"]);
    expect(backing.getItem("vemi:local:vemi:outbox:v1")).toBeNull();
    expect(backing.getItem("other-app")).toBe("keep");
    expect(session.length).toBe(0);
    if (out.ok) {
      expect(out.said).toMatch(/database/);
      expect(out.said).toMatch(/keys/);
      expect(out.said).toMatch(/session/);
      expect(out.said).not.toContain(String.fromCharCode(0x2014));
    }
  });

  it("leaves everything as it was when the database cannot be let go", async () => {
    const { deps, backing, session } = rig();
    deps.removeDirectory = vi.fn(async () => { throw new Error("locked"); });
    const out = await wipeDevice(deps);
    expect(out.ok).toBe(false);
    expect(deps.deleteKeys).not.toHaveBeenCalled();
    expect(backing.getItem("vemi:local:vemi:outbox:v1")).toBe("x");
    expect(session.length).toBe(1);
  });

  it("treats a directory that is already gone as cleared", async () => {
    const { deps } = rig();
    deps.removeDirectory = vi.fn(async () => { throw Object.assign(new Error("none"), { name: "NotFoundError" }); });
    expect((await wipeDevice(deps)).ok).toBe(true);
  });
});

describe("removeLocalKey", () => {
  it("removes this device's own saved key and leaves a signed-in account's key on the same origin", async () => {
    const shelf = memoryShelf();
    const key = { fieldKey: {}, keyRef: "r", deviceId: "d" } as unknown as DeviceKey;
    await shelf.put(LOCAL_KEY_NAME, key);
    await shelf.put("someone@example.test", key);
    await removeLocalKey(shelf);
    expect([...shelf.entries.keys()]).toEqual(["someone@example.test"]);
  });
});
