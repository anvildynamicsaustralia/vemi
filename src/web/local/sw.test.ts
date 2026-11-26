import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { ROOT } from "../../../tests/walk.js";

/**
 * Two workers share one origin: the app's, scope `/`, and the one for `/try/`. The app's must
 * stay out of every `/try` request, or it would answer the local page with the signed-in
 * app's shell; the local one answers only the local page and its files.
 */

const read = (path: string): string => readFileSync(join(ROOT, path), "utf8");
const comments = (text: string): string => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

type Listener = (event: unknown) => void;

/** Runs a worker's source against a stand-in browser. Answers what it did for a request. */
function worker(path: string, files: readonly string[] = []) {
  const stamped = read(path).replace("\"__VEMI_BUILD__\"", "\"test\"").replace("\"__VEMI_FILES__\"", JSON.stringify(files));
  const listeners = new Map<string, Listener>();
  const kept = new Map<string, Response>();
  const cacheNames = new Set<string>(["vemi-shell-old", "vemi-data-v1", "vemi-try-shell-old"]);
  const fetched: string[] = [];
  const cache = {
    put: (request: Request | string, response: Response) => {
      kept.set(typeof request === "string" ? request : new URL(request.url).pathname, response);
      return Promise.resolve();
    },
    match: (request: Request | string) => Promise.resolve(kept.get(typeof request === "string" ? request : new URL(request.url).pathname)),
  };
  const context = {
    self: {
      addEventListener: (type: string, fn: Listener) => listeners.set(type, fn),
      location: { origin: "https://vemi.test" },
      skipWaiting: () => Promise.resolve(),
      clients: { claim: () => Promise.resolve() },
    },
    caches: {
      open: (name: string) => { cacheNames.add(name); return Promise.resolve(cache); },
      keys: () => Promise.resolve([...cacheNames]),
      delete: (name: string) => Promise.resolve(cacheNames.delete(name)),
    },
    fetch: (input: string | Request) => {
      const url = typeof input === "string" ? input : input.url;
      fetched.push(new URL(url, "https://vemi.test").pathname);
      return Promise.resolve(new Response("body", { status: 200, headers: { "content-type": "text/plain" } }));
    },
    Request: function request(input: string, init?: RequestInit) { return new Request(new URL(input, "https://vemi.test").href, init); },
    Response, Headers, URL, Date, Promise, JSON, Array, setTimeout, clearTimeout,
  };
  runInNewContext(stamped, context);
  const ask = (path: string, mode = "navigate", method = "GET"): boolean => {
    let responded = false;
    listeners.get("fetch")?.({ request: { method, url: `https://vemi.test${path}`, mode }, respondWith: () => { responded = true; } });
    return responded;
  };
  const run = async (type: string): Promise<void> => {
    let work: Promise<unknown> = Promise.resolve();
    listeners.get(type)?.({ waitUntil: (p: Promise<unknown>) => { work = p; } });
    await work;
  };
  return { ask, run, listeners, kept, cacheNames, fetched };
}

describe("the app's worker, beside /try", () => {
  it("returns early for /try and everything under it, as it does for /get/", () => {
    const app = worker("src/web/sw.js");
    for (const path of ["/try", "/try/", "/try/index.html", "/try/assets/dbWorker-1.js", "/try/sw.js"]) {
      expect(app.ask(path), path).toBe(false);
    }
    // The app itself is still answered.
    expect(app.ask("/")).toBe(true);
    expect(app.ask("/today")).toBe(true);
  });

  it("does not take a path that only begins with the letters", () => {
    expect(worker("src/web/sw.js").ask("/trying", "navigate")).toBe(true);
  });
});

describe("the worker for /try/", () => {
  const source = comments(read("try/sw.js"));

  it("has no /api/ handling, no push handler and no other origin", () => {
    expect(source).not.toMatch(/\/api\//);
    expect(source).not.toMatch(/\/auth\//);
    expect(source).not.toMatch(/["']push["']|notificationclick|showNotification|pushsubscription/i);
    expect(source).not.toMatch(/https?:\/\//);
  });

  it("carries exactly one build stamp and one file list for the build to fill in", () => {
    expect(source.split("\"__VEMI_BUILD__\"").length).toBe(2);
    expect(source.split("\"__VEMI_FILES__\"").length).toBe(2);
  });

  it("never asks for a path a static server answers with a redirect", () => {
    const paths = [...source.matchAll(/["'`](\/[^"'`\s]*)["'`]/g)].map((m) => m[1] ?? "");
    expect(paths.filter((p) => p.endsWith(".html"))).toEqual([]);
  });

  it("keeps the /try/ page and its files at install, and only its own caches are ever dropped", async () => {
    const files = ["/assets/try-1.js", "/try/assets/dbWorker-1.js", "/try/assets/sqlite3-1.wasm"];
    const local = worker("try/sw.js", files);
    await local.run("install");
    expect([...local.kept.keys()].sort()).toEqual(["/try/", ...files].sort());
    expect(local.fetched.every((p) => p === "/try/" || files.includes(p))).toBe(true);
    await local.run("activate");
    // The app's shell and data caches are not this worker's to delete.
    expect(local.cacheNames.has("vemi-shell-old")).toBe(true);
    expect(local.cacheNames.has("vemi-data-v1")).toBe(true);
    expect(local.cacheNames.has("vemi-try-shell-old")).toBe(false);
    expect(local.cacheNames.has("vemi-try-shell-test")).toBe(true);
  });

  it("answers the /try/ page and its files, and nothing else", () => {
    const local = worker("try/sw.js");
    expect(local.ask("/try/")).toBe(true);
    expect(local.ask("/try")).toBe(true);
    expect(local.ask("/assets/try-1.js", "no-cors")).toBe(true);
    expect(local.ask("/try/assets/sqlite3-1.wasm", "cors")).toBe(true);
    // Not a write, not an API request, not the app's own pages.
    expect(local.ask("/try/", "navigate", "POST")).toBe(false);
    expect(local.ask("/api/overview", "cors")).toBe(false);
    expect(local.ask("/auth/me", "cors")).toBe(false);
    expect(local.ask("/today", "navigate")).toBe(false);
    expect(local.ask("/", "navigate")).toBe(false);
  });
});
