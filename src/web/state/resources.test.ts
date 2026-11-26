import { afterEach, describe, expect, it, vi } from "vitest";
import { clearResources, load, onSignedOut, readSince, readsBegun, resourceAt } from "./resources.js";

afterEach(() => {
  vi.unstubAllGlobals();
  clearResources();
});

describe("load", () => {
  it("runs once more when asked again while a load is running", async () => {
    const releases: (() => void)[] = [];
    const doFetch = vi.fn(() => new Promise<Response>((resolve) => {
      releases.push(() => resolve(new Response("{}", { status: 200, headers: { "content-type": "application/json" } })));
    }));
    vi.stubGlobal("fetch", doFetch);

    const first = load("/api/again");
    void load("/api/again");
    void load("/api/again");
    expect(doFetch).toHaveBeenCalledTimes(1);

    releases[0]?.();
    await first;
    await vi.waitFor(() => expect(doFetch).toHaveBeenCalledTimes(2));
    releases[1]?.();
    await new Promise((r) => setTimeout(r, 0));
    expect(doFetch).toHaveBeenCalledTimes(2);
  });
});

describe("readSince", () => {
  const ok = (body: unknown): Response =>
    new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

  it("waits for a read begun after the mark, not one already on its way", async () => {
    const releases: ((r: Response) => void)[] = [];
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((resolve) => { releases.push(resolve); })));

    const early = load("/api/since");
    const mark = readsBegun();
    releases[0]?.(ok({ title: "before the write" }));
    await early;
    expect(readSince(mark, ["/api/since"])).toBe(false);

    const late = load("/api/since");
    releases[1]?.(ok({ title: "after it" }));
    await late;
    expect(readSince(mark, ["/api/since"])).toBe(true);
  });

  it("waits for every path asked about", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(ok({}))));
    const mark = readsBegun();
    await load("/api/one");
    expect(readSince(mark, ["/api/one", "/api/two"])).toBe(false);
    await load("/api/two");
    expect(readSince(mark, ["/api/one", "/api/two"])).toBe(true);
  });

  it("does not count a read that failed", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new TypeError("Failed to fetch"))));
    const mark = readsBegun();
    await load("/api/unreached");
    expect(readSince(mark, ["/api/unreached"])).toBe(false);
  });
});

describe("clearResources", () => {
  const json = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  it("drops the answer of a load still on its way when it was cleared, and the second ask with it", async () => {
    const releases: ((r: Response) => void)[] = [];
    const doFetch = vi.fn(() => new Promise<Response>((resolve) => { releases.push(resolve); }));
    vi.stubGlobal("fetch", doFetch);
    const seen: unknown[] = [];
    const stop = onSignedOut(() => seen.push("signed out"));

    const old = load("/api/before");
    void load("/api/before");
    clearResources();
    releases[0]?.(json({ venture: "the last account's" }));
    await old;
    await new Promise((r) => setTimeout(r, 0));
    expect(doFetch).toHaveBeenCalledTimes(1);

    // A fresh load after the clear asks the Worker, and is not handed the old one's promise.
    const fresh = load("/api/before");
    expect(doFetch).toHaveBeenCalledTimes(2);
    releases[1]?.(json({ venture: "this account's" }));
    await fresh;
    stop();
    expect(seen).toEqual([]);
  });

  it("does not sign out for a 401 that answered the session before the clear", async () => {
    let release: (r: Response) => void = () => {};
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((resolve) => { release = resolve; })));
    const seen: string[] = [];
    const stop = onSignedOut(() => seen.push("signed out"));
    const old = load("/api/gone");
    clearResources();
    release(json({ error: "sign in first" }, 401));
    await old;
    stop();
    expect(seen).toEqual([]);
  });
});

describe("a failed read", () => {
  const json = (status: number, body: unknown): Response =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  it("is unreached when no answer came back at all", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new TypeError("Failed to fetch"))));
    await load("/api/far");
    expect(resourceAt("/api/far")).toMatchObject({ unreached: true, error: "Failed to fetch", loading: false });
  });

  it("is not unreached when the Worker answered with a failure", async () => {
    for (const status of [500, 503]) {
      vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(json(status, { error: "resting" }))));
      await load(`/api/said-${status}`);
      expect(resourceAt(`/api/said-${status}`)).toMatchObject({ unreached: false, error: "resting" });
    }
  });

  it("stops being unreached once an answer comes", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new TypeError("Failed to fetch"))));
    await load("/api/back");
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(json(200, { ok: 1 }))));
    await load("/api/back");
    expect(resourceAt("/api/back")).toMatchObject({ unreached: false, error: null, data: { ok: 1 } });
  });
});

describe("an answer read again", () => {
  const json = (body: unknown): Response =>
    new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

  it("keeps the object on screen when it says the same, and takes the new one when it does not", async () => {
    let body: unknown = { ventures: [{ id: "v1" }] };
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(json(body))));
    await load("/api/same");
    const first = resourceAt("/api/same").data;
    expect(first).toEqual({ ventures: [{ id: "v1" }] });

    await load("/api/same");
    expect(resourceAt("/api/same").data).toBe(first);

    body = { ventures: [{ id: "v2" }] };
    await load("/api/same");
    expect(resourceAt("/api/same").data).not.toBe(first);
    expect(resourceAt("/api/same").data).toEqual({ ventures: [{ id: "v2" }] });
  });

  it("is loading only while there is nothing to show yet", async () => {
    let release: (r: Response) => void = () => {};
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((resolve) => { release = resolve; })));
    const first = load("/api/loading");
    expect(resourceAt("/api/loading").loading).toBe(true);
    release(json({ n: 1 }));
    await first;
    expect(resourceAt("/api/loading").loading).toBe(false);

    const again = load("/api/loading");
    expect(resourceAt("/api/loading")).toMatchObject({ loading: false, data: { n: 1 } });
    release(json({ n: 2 }));
    await again;
    expect(resourceAt("/api/loading")).toMatchObject({ loading: false, data: { n: 2 } });
  });
});
