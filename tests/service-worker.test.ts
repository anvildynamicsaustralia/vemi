import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { ROOT } from "./walk.js";

/**
 * The service worker stands between the phone and every page load, so a mistake in it is
 * the whole app down while the Worker answers fine. It happened on 2026-09-15: the worker
 * asked for the page at `/index.html`, Cloudflare's asset serving answers that with a 307 to
 * `/`, and a browser refuses a redirected answer to a page load.
 *
 * These read the worker's source and hold it to what the Worker actually serves.
 */

const source = readFileSync(join(ROOT, "src/web/sw.js"), "utf8");
const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

describe("the service worker", () => {
  it("never asks for a path the Worker answers with a redirect", () => {
    // Cloudflare's html handling redirects `/index.html` and any `*.html` to the bare path.
    const paths = [...code.matchAll(/["'`](\/[^"'`\s]*)["'`]/g)].map((m) => m[1] ?? "");
    expect(paths.filter((p) => p.endsWith(".html"))).toEqual([]);
  });

  it("keeps a .png as a built file", () => {
    expect(code).toMatch(/const isBuilt = [^;]*pathname\.endsWith\("\.png"\);/);
  });

  it("asks for the page at the root", () => {
    expect(code).toMatch(/const PAGE = "\/";/);
    expect(code).toMatch(/request\.mode === "navigate"[\s\S]*new Request\(PAGE\)/);
  });

  it("never answers a page load with a redirected response", () => {
    expect(code).toMatch(/response\.redirected/);
  });

  it("carries exactly one build stamp and one file list for the build to fill in", () => {
    expect(code.split("\"__VEMI_BUILD__\"").length).toBe(2);
    expect(code.split("\"__VEMI_FILES__\"").length).toBe(2);
  });

  it("keeps the page and the build's files before it takes over from the last build", () => {
    expect(code).toMatch(/addEventListener\("install"[\s\S]*cache\.put\(path[\s\S]*skipWaiting/);
  });

  it("does not keep the app's page under another file's name", () => {
    expect(code).toMatch(/text\/html/);
  });
});

/**
 * The worker itself, run against a stand-in for the browser: a storage that refuses every
 * write, as a full phone does, and a Worker that answers.
 */
describe("the service worker, when the device will not keep a copy", () => {
  type Listener = (event: unknown) => void;

  function load(): Map<string, Listener> {
    const listeners = new Map<string, Listener>();
    const refusing = {
      put: () => Promise.reject(new DOMException("Entry already exists.", "InvalidAccessError")),
      match: () => Promise.resolve(undefined),
    };
    const context = {
      self: { addEventListener: (type: string, fn: Listener) => listeners.set(type, fn), location: { origin: "https://vemi.test" } },
      caches: { open: () => Promise.resolve(refusing) },
      fetch: () => Promise.resolve(new Response("{\"ok\":true}", { status: 200, headers: { "content-type": "application/json" } })),
      Request, Response, Headers, URL, Date, Promise, JSON, Array, setTimeout, clearTimeout,
    };
    runInNewContext(source, context);
    return listeners;
  }

  async function answer(path: string): Promise<Response> {
    let responded: Promise<Response> | undefined;
    load().get("fetch")?.({
      request: new Request(`https://vemi.test${path}`),
      respondWith: (p: Promise<Response>) => { responded = p; },
    });
    if (responded === undefined) throw new Error(`the worker did not answer ${path}`);
    return responded;
  }

  it("still hands over the Worker's answer to a read", async () => {
    const response = await answer("/api/overview");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });

  it("still hands over a built file", async () => {
    expect((await answer("/assets/index.js")).status).toBe(200);
  });
});

/**
 * The setup page at `/get` stands apart from the app. A phone with the app installed asks the
 * worker first, and the worker answers every other page load with the app's shell; for `/get`
 * it must stay out of it, so the browser goes to the network for the page itself.
 */
describe("the service worker, on the setup page", () => {
  type Listener = (event: unknown) => void;

  function answers(path: string, mode: string): boolean {
    const listeners = new Map<string, Listener>();
    const context = {
      self: { addEventListener: (type: string, fn: Listener) => listeners.set(type, fn), location: { origin: "https://vemi.test" } },
      caches: { open: () => Promise.resolve({ put: () => Promise.resolve(), match: () => Promise.resolve(undefined) }) },
      fetch: () => Promise.resolve(new Response("<html></html>", { status: 200, headers: { "content-type": "text/html" } })),
      // In a worker the page's own address is the base of "/"; here it is given.
      Request: function request(input: string, init?: RequestInit) { return new Request(new URL(input, "https://vemi.test").href, init); },
      Response, Headers, URL, Date, Promise, JSON, Array, setTimeout, clearTimeout,
    };
    runInNewContext(source, context);
    let responded = false;
    listeners.get("fetch")?.({
      // A page load cannot be built as a Request, so the worker is handed the parts it reads.
      request: { method: "GET", url: `https://vemi.test${path}`, mode },
      respondWith: () => { responded = true; },
    });
    return responded;
  }

  it("answers a page load of the app with the shell", () => {
    expect(answers("/", "navigate")).toBe(true);
    expect(answers("/today", "navigate")).toBe(true);
  });

  it("answers no navigation to /get with the app shell", () => {
    for (const path of ["/get", "/get/", "/get/index.html", "/get/relay"]) expect(answers(path, "navigate")).toBe(false);
  });

  it("does not take a path that only begins with the letters", () => {
    expect(answers("/getting-started", "navigate")).toBe(true);
  });
});
