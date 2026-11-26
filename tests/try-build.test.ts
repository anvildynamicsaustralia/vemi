import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { build } from "vite";
import { LOCAL_PREFIX, namespaced, type StorageLike } from "../src/web/local/storage.js";
import { ROOT } from "./walk.js";

/**
 * The built output, read as files. One build for the whole file, into a scratch folder.
 *
 * The copy at `/try` keeps its data in the browser, so the database engine and its wasm ship
 * with it, and with nothing else: the signed-in app's page must not load them, must not name
 * them, and its worker must not keep them.
 */

let out = "";

const read = (path: string): string => readFileSync(join(out, path), "utf8");
const exists = (path: string): boolean => statSync(join(out, path), { throwIfNoEntry: false }) !== undefined;
const files = (dir: string): string[] => readdirSync(join(out, dir), { recursive: true, encoding: "utf8" }).map((f) => f.replaceAll("\\", "/"));

/** The files a page names in its own tags: its scripts and what it preloads. */
function referenced(html: string): string[] {
  return [...html.matchAll(/(?:src|href)="\/(assets\/[^"]+\.(?:js|css))"/g)].map((m) => m[1] ?? "");
}

/** The files a worker keeps, as written in its `FILES` list. */
function kept(worker: string): string[] {
  const match = /const FILES = (\[[^\]]*\])/.exec(read(worker));
  if (match === null) throw new Error(`${worker} has no file list`);
  return JSON.parse(match[1] ?? "[]") as string[];
}

beforeAll(async () => {
  out = mkdtempSync(join(tmpdir(), "vemi-try-build-"));
  await build({ root: ROOT, logLevel: "silent", build: { outDir: out, emptyOutDir: true } });
}, 240_000);

afterAll(() => {
  if (out !== "") rmSync(out, { recursive: true, force: true });
});

describe("the build, beside the app", () => {
  it("emits the /try page, its worker, and the database worker and wasm under try/assets", () => {
    for (const path of ["try/index.html", "try/sw.js", "index.html", "sw.js", "get/index.html"]) expect(exists(path), path).toBe(true);
    const own = files("try/assets");
    expect(own.some((f) => /^dbWorker-.*\.js$/.test(f))).toBe(true);
    expect(own.some((f) => /\.wasm$/.test(f))).toBe(true);
    expect(files("assets").some((f) => f.endsWith(".wasm"))).toBe(false);
  });

  it("loads the /try page from its own entry, at paths a static host serves", () => {
    const page = read("try/index.html");
    expect(page).not.toMatch(/<script(?![^>]*\ssrc=)[^>]*>/);
    expect(page).toMatch(/<script type="module"[^>]* src="\/assets\/try-[^"]+\.js"/);
    expect(page).not.toMatch(/https?:\/\//);
    // Its own manifest, never the app's: that one's start_url is the signed-in app.
    expect(page).toContain('<link rel="manifest" href="/try/manifest.webmanifest" />');
    expect(page).not.toContain('href="/manifest.webmanifest"');
  });

  it("installs /try as its own app: a manifest of its own, in its own scope, with icons that exist", () => {
    expect(exists("try/manifest.webmanifest")).toBe(true);
    const manifest = JSON.parse(read("try/manifest.webmanifest")) as {
      id: string; start_url: string; scope: string; display: string; icons: { src: string; sizes: string; purpose?: string }[];
    };
    expect(manifest.id).toBe("/try/");
    expect(manifest.start_url).toBe("/try/");
    expect(manifest.scope).toBe("/try/");
    expect(manifest.display).toBe("standalone");
    expect(manifest.icons.some((i) => i.sizes === "192x192")).toBe(true);
    expect(manifest.icons.some((i) => i.sizes === "512x512")).toBe(true);
    for (const icon of manifest.icons) expect(exists(icon.src.slice(1)), icon.src).toBe(true);
    // The app's manifest still starts the signed-in app, untouched.
    expect((JSON.parse(read("manifest.webmanifest")) as { start_url: string }).start_url).toBe("/");
  });

  it("keeps the /try policy strict: nothing inline, nothing but its own origin, a manifest from itself", () => {
    const headers = readFileSync(join(ROOT, "public/_headers"), "utf8");
    const block = /^\/try\/\*\r?\n([\s\S]*?)(?:\r?\n\r?\n|(?![\s\S]))/m.exec(headers)?.[1] ?? "";
    const policy = /Content-Security-Policy: (.*)/.exec(block)?.[1] ?? "";
    expect(policy).not.toBe("");
    expect(policy).toContain("default-src 'none'");
    expect(policy).toContain("manifest-src 'self'");
    expect(policy).toMatch(/style-src 'self';/);
    expect(policy).not.toContain("unsafe-inline");
    expect(policy).not.toMatch(/https?:/);
  });

  it("keeps the database out of the app's page: its entry chunks name neither sqlite nor vemi-local", () => {
    const page = read("index.html");
    expect(page).not.toContain("try/");
    const entry = referenced(page);
    expect(entry.some((f) => f.startsWith("assets/main-"))).toBe(true);
    const script = entry.find((f) => f.startsWith("assets/main-") && f.endsWith(".js")) ?? "";
    expect(script).not.toBe("");
    for (const file of entry.filter((f) => f.endsWith(".js"))) {
      const code = read(file);
      // Booleans, so a failure names the file and does not print a bundle. The entry itself
      // names no sqlite at all; a chunk it preloads may say the word (the setup page's
      // chunk talks about Cloudflare's own database), but never the engine or its storage.
      const pattern = file === script ? /sqlite/i : /sqlite3|sqlite-wasm|sqlite\.org|opfs/i;
      expect(pattern.test(code), `${file} names sqlite`).toBe(false);
      expect(code.includes("vemi-local"), `${file} names vemi-local`).toBe(false);
      expect(code.includes("try/assets"), `${file} names try/assets`).toBe(false);
    }
  });

  it("leaves everything of the /try page's own out of the app's worker, and stamps both", () => {
    const app = kept("sw.js");
    expect(app.length).toBeGreaterThan(5);
    for (const path of app) {
      expect(path.startsWith("/assets/"), path).toBe(true);
      expect(path, path).not.toMatch(/sqlite|dbWorker|\.wasm|\/try-/);
    }
    expect(app.some((path) => path.startsWith("/assets/main-"))).toBe(true);
    for (const worker of ["sw.js", "try/sw.js"]) expect(read(worker)).not.toContain("__VEMI_");
  });

  it("has the /try worker keep the page's entry, the app's code it runs, the database worker and the wasm", () => {
    const local = kept("try/sw.js");
    expect(local.some((p) => /^\/assets\/try-.*\.js$/.test(p))).toBe(true);
    expect(local.some((p) => /^\/assets\/main-.*\.js$/.test(p))).toBe(true);
    expect(local.some((p) => /^\/try\/assets\/dbWorker-.*\.js$/.test(p))).toBe(true);
    expect(local.some((p) => /^\/try\/assets\/sqlite3-.*\.wasm$/.test(p))).toBe(true);
    for (const path of local) expect(exists(path.slice(1)), path).toBe(true);
  });
});

describe("the keys the local bundle writes", () => {
  it("all land under vemi:local: once the storage wrapper is in place", () => {
    const code = [...files("assets").filter((f) => f.endsWith(".js")).map((f) => `assets/${f}`),
      ...files("try/assets").filter((f) => f.endsWith(".js")).map((f) => `try/assets/${f}`)].map(read).join("\n");
    const keys = new Set<string>();
    for (const m of code.matchAll(/["'`](vemi[:.][A-Za-z0-9:._${}-]*)["'`]/g)) keys.add((m[1] ?? "").replace(/\$\{[^}]*\}/g, "x"));
    expect([...keys]).toContain("vemi:outbox:v1");
    expect(keys.size).toBeGreaterThan(5);

    const store = new Map<string, string>();
    const backing: StorageLike = {
      get length() { return store.size; },
      key: (i) => [...store.keys()][i] ?? null,
      getItem: (k) => store.get(k) ?? null,
      setItem: (k, v) => void store.set(k, v),
      removeItem: (k) => void store.delete(k),
      clear: () => store.clear(),
    };
    const view = namespaced(backing);
    for (const key of keys) view.setItem(key, "1");
    const written = [...store.keys()];
    expect(written).toHaveLength(keys.size);
    expect(written.filter((k) => !k.startsWith(LOCAL_PREFIX))).toEqual([]);
  });
});
