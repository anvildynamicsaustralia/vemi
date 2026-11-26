import { describe, expect, it, vi } from "vitest";
import { lastPush, lastPushHere, parseRepo, type RepoStorage } from "./githubRepo.js";

function memory(): RepoStorage {
  const data = new Map<string, string>();
  return {
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
  };
}

const repo = { owner: "anvildynamicsau", name: "vemi", url: "https://github.com/anvildynamicsau/vemi" };
const ok = (pushed: string) => async () =>
  ({ ok: true, json: async () => ({ pushed_at: pushed }) }) as unknown as Response;

describe("parseRepo", () => {
  it("accepts owner/name", () => {
    expect(parseRepo("anvildynamicsau/vemi")).toEqual(repo);
  });
  it("accepts a github.com URL, with or without extras", () => {
    expect(parseRepo("https://github.com/anvildynamicsau/vemi")).toEqual(repo);
    expect(parseRepo("https://www.github.com/anvildynamicsau/vemi.git/")).toEqual(repo);
    expect(parseRepo("github.com/anvildynamicsau/vemi/issues")).toEqual(repo);
  });
  it("returns null for anything else", () => {
    expect(parseRepo("")).toBeNull();
    expect(parseRepo("vemi")).toBeNull();
    expect(parseRepo("https://gitlab.com/a/b")).toBeNull();
    expect(parseRepo("https://github.com/onlyowner")).toBeNull();
    expect(parseRepo("a b/c")).toBeNull();
  });
});

describe("lastPushHere", () => {
  it("makes no request in local mode", async () => {
    const spy = vi.fn(async () => new Response("{}"));
    expect(await lastPushHere(repo, spy, memory(), true)).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });

  it("looks the push up otherwise", async () => {
    expect(await lastPushHere(repo, ok("2026-11-01T10:00:00Z"), memory(), false)).toBe("2026-11-01T10:00:00Z");
  });
});

describe("lastPush", () => {
  it("fetches, returns pushed_at and caches it", async () => {
    const storage = memory();
    let calls = 0;
    const fetcher = async (u: string) => {
      calls++;
      expect(u).toBe("https://api.github.com/repos/anvildynamicsau/vemi");
      return ok("2026-11-01T10:00:00Z")();
    };
    expect(await lastPush(repo, fetcher, storage, 1000)).toBe("2026-11-01T10:00:00Z");
    expect(await lastPush(repo, fetcher, storage, 1000 + 14 * 60_000)).toBe("2026-11-01T10:00:00Z");
    expect(calls).toBe(1);
  });
  it("fetches again once the cache is 15 minutes old", async () => {
    const storage = memory();
    await lastPush(repo, ok("a"), storage, 0);
    expect(await lastPush(repo, ok("b"), storage, 15 * 60_000)).toBe("b");
  });
  it("returns null on a non-OK response", async () => {
    const fetcher = async () => ({ ok: false, json: async () => ({}) }) as unknown as Response;
    expect(await lastPush(repo, fetcher, memory(), 0)).toBeNull();
  });
  it("returns null when fetch throws", async () => {
    const fetcher = async () => {
      throw new Error("offline");
    };
    expect(await lastPush(repo, fetcher, memory(), 0)).toBeNull();
  });
  it("never throws when storage does", async () => {
    const bad: RepoStorage = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };
    expect(await lastPush(repo, ok("x"), bad, 0)).toBe("x");
  });
  it("returns null for a body with no pushed_at", async () => {
    const fetcher = async () => ({ ok: true, json: async () => ({}) }) as unknown as Response;
    expect(await lastPush(repo, fetcher, memory(), 0)).toBeNull();
  });
});
