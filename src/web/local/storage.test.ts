import { describe, expect, it } from "vitest";
import { installLocalStorage, LOCAL_PREFIX, namespaced, type StorageLike } from "./storage.js";

function memory(): StorageLike & { keys(): string[] } {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    key: (i) => [...map.keys()][i] ?? null,
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
    clear: () => map.clear(),
    keys: () => [...map.keys()],
  };
}

describe("the local storage namespace", () => {
  it("writes every key under vemi:local: and reads it back by its own name", () => {
    const backing = memory();
    const view = namespaced(backing);
    view.setItem("vemi:outbox:v1", "[]");
    view.setItem("vemi.names", "x");
    expect(backing.keys()).toEqual([`${LOCAL_PREFIX}vemi:outbox:v1`, `${LOCAL_PREFIX}vemi.names`]);
    expect(view.getItem("vemi:outbox:v1")).toBe("[]");
    view.removeItem("vemi.names");
    expect(backing.keys()).toEqual([`${LOCAL_PREFIX}vemi:outbox:v1`]);
  });

  it("never sees, counts or clears a key outside the prefix", () => {
    const backing = memory();
    backing.setItem("vemi:outbox:v1", "signed-in copy");
    const view = namespaced(backing);
    expect(view.getItem("vemi:outbox:v1")).toBeNull();
    expect(view.length).toBe(0);
    view.setItem("a", "1");
    expect(view.length).toBe(1);
    expect(view.key(0)).toBe("a");
    expect(view.key(1)).toBeNull();
    view.clear();
    expect(backing.keys()).toEqual(["vemi:outbox:v1"]);
  });

  it("replaces localStorage on its target once, and leaves a refused storage alone", () => {
    const backing = memory();
    const target = { localStorage: backing };
    installLocalStorage(target);
    target.localStorage.setItem("k", "v");
    expect(backing.keys()).toEqual([`${LOCAL_PREFIX}k`]);

    const refused = {} as { localStorage: StorageLike };
    Object.defineProperty(refused, "localStorage", { get: () => { throw new Error("denied"); }, configurable: true });
    expect(() => installLocalStorage(refused)).not.toThrow();
  });
});
