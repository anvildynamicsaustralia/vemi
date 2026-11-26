import { describe, expect, it, vi } from "vitest";
import { loadWithRetry, loadedFine, reloadOnce } from "./lazyView.js";

function memory(): Storage {
  const data = new Map<string, string>();
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
    removeItem: (key: string) => void data.delete(key),
  } as unknown as Storage;
}

describe("loading a view", () => {
  it("tries a failed import once more", async () => {
    const load = vi.fn().mockRejectedValueOnce(new Error("chunk")).mockResolvedValueOnce({ ok: 1 });
    expect(await loadWithRetry(load)).toEqual({ ok: 1 });
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("gives up after the second failure", async () => {
    const load = vi.fn().mockRejectedValue(new Error("chunk"));
    await expect(loadWithRetry(load)).rejects.toThrow("chunk");
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("does not retry a good import", async () => {
    const load = vi.fn().mockResolvedValue({});
    await loadWithRetry(load);
    expect(load).toHaveBeenCalledTimes(1);
  });
});

describe("reloading for a view that will not load", () => {
  it("reloads once, then leaves the page alone", () => {
    const store = memory();
    const reload = vi.fn();
    expect(reloadOnce(store, reload)).toBe(true);
    expect(reloadOnce(store, reload)).toBe(false);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("may reload again after a view loaded fine", () => {
    const store = memory();
    const reload = vi.fn();
    reloadOnce(store, reload);
    loadedFine(store);
    expect(reloadOnce(store, reload)).toBe(true);
    expect(reload).toHaveBeenCalledTimes(2);
  });

  it("does not reload without storage", () => {
    const broken = {
      getItem: () => {
        throw new Error("no");
      },
      setItem: () => {},
    };
    const reload = vi.fn();
    expect(reloadOnce(broken, reload)).toBe(false);
    expect(reload).not.toHaveBeenCalled();
  });
});
