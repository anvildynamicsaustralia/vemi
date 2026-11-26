import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { DATA_CACHE, forgetKeptData } from "./keptData.js";

describe("forgetting what the service worker kept", () => {
  it("deletes the copy from the page when no worker controls it, as after a hard reload", async () => {
    const deleted: string[] = [];
    const told: unknown[] = [];
    await forgetKeptData({
      caches: { delete: async (name) => { deleted.push(name); return true; } },
      serviceWorker: { ready: Promise.resolve({ active: { postMessage: (m) => { told.push(m); } } }) },
    });
    expect(deleted).toEqual([DATA_CACHE]);
    // So the worker drops a read it has in flight, as well as the copy.
    await Promise.resolve();
    expect(told).toEqual(["forget-data"]);
  });

  it("does not wait on a worker that was never registered", async () => {
    const deleted: string[] = [];
    await forgetKeptData({
      caches: { delete: async (name) => { deleted.push(name); return true; } },
      serviceWorker: { ready: new Promise(() => undefined) },
    });
    expect(deleted).toEqual([DATA_CACHE]);
  });

  it("settles where there is no cache to reach", async () => {
    await expect(forgetKeptData({ caches: undefined, serviceWorker: undefined })).resolves.toBeUndefined();
    await expect(forgetKeptData({
      caches: { delete: async () => { throw new Error("blocked"); } },
      serviceWorker: undefined,
    })).resolves.toBeUndefined();
  });

  it("names the cache the worker keeps answers in", () => {
    const source = readFileSync(new URL("./sw.js", import.meta.url), "utf8");
    expect(source).toContain(`const DATA = "${DATA_CACHE}";`);
  });
});
