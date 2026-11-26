import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { build } from "vite";
import { ROOT } from "./walk.js";

/**
 * The page at `/try` under the strictest policy the app has, read from the built files.
 *
 * Nothing the page needs may be blocked by it, and nothing in the built output may reach for
 * more than it grants: no inline script, no script or link from another origin, no style
 * attribute, no web address the code could fetch. The header block is pinned word for word, so
 * a loosening is a failing test and not a quiet edit.
 */

/** The policy for `/try/*`. `'unsafe-inline'` and `'unsafe-eval'` never appear, and no host name. */
const POLICY = [
  "default-src 'none'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "worker-src 'self'",
  "manifest-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

/**
 * Web addresses allowed in the built files of the page, each with its reason. A key is the
 * whole address as it appears; empty unless the address sits in a string the app only prints.
 */
const ALLOWED: Readonly<Record<string, string>> = {
  "https://sqlite.org/wasm/doc/trunk/persistence.md#coop-coep":
    "inside the engine's console warning about missing isolation headers; printed, never fetched",
};

let out = "";

const read = (path: string): string => readFileSync(join(out, path), "utf8");
const under = (dir: string): string[] =>
  readdirSync(join(out, dir), { recursive: true, encoding: "utf8" }).map((f) => `${dir}/${f.replaceAll("\\", "/")}`);

/** The `/try/*` block of a headers file: its lines, trimmed. */
function block(headers: string): string[] {
  const lines = headers.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === "/try/*");
  if (start < 0) return [];
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => !/^\s/.test(line));
  return (end < 0 ? rest : rest.slice(0, end)).map((line) => line.trim()).filter((line) => line !== "");
}

/** Script text with block comments and line comments removed (a `//` after a colon is an address). */
const withoutComments = (code: string): string =>
  code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:\w"'`])\/\/[^\n]*/g, "$1");

beforeAll(async () => {
  out = mkdtempSync(join(tmpdir(), "vemi-try-csp-"));
  await build({ root: ROOT, logLevel: "silent", build: { outDir: out, emptyOutDir: true } });
}, 240_000);

afterAll(() => {
  if (out !== "") rmSync(out, { recursive: true, force: true });
});

describe("the /try header block", () => {
  it("is exactly the strict policy, in the source and in the build", () => {
    const expected = ["! Content-Security-Policy", `Content-Security-Policy: ${POLICY}`];
    expect(block(readFileSync(join(ROOT, "public", "_headers"), "utf8"))).toEqual(expected);
    expect(block(read("_headers"))).toEqual(expected);
  });

  it("never grants inline or eval script, or a host name", () => {
    expect(POLICY).not.toMatch(/'unsafe-(?:inline|eval)'|https?:|\*/);
  });
});

describe("the built /try page, under that policy", () => {
  it("has no inline script, no inline style, no style attribute and no handler attribute", () => {
    const page = read("try/index.html");
    expect(page).not.toMatch(/<script(?![^>]*\ssrc=)[^>]*>/i);
    expect(page).not.toMatch(/<style[\s>]/i);
    expect(page).not.toMatch(/\sstyle\s*=/i);
    expect(page).not.toMatch(/\son[a-z]+\s*=/i);
  });

  it("loads every script and link from its own origin", () => {
    const page = read("try/index.html");
    const targets = [...page.matchAll(/<(?:script|link)\b[^>]*?\s(?:src|href)="([^"]*)"/gi)].map((m) => m[1] ?? "");
    expect(targets.length).toBeGreaterThan(2);
    for (const target of targets) {
      expect(target, target).toMatch(/^\/(?!\/)/);
    }
  });

  it("names no web address in its built files, bar the listed strings that are only printed", () => {
    const found = new Set<string>();
    for (const file of under("try").filter((f) => /\.(?:js|mjs|css|html)$/.test(f))) {
      for (const m of withoutComments(read(file)).matchAll(/https?:\/\/[A-Za-z0-9][^\s"'`)<>]*/g)) found.add(m[0]);
    }
    const unlisted = [...found].filter((address) => !(address in ALLOWED));
    expect(unlisted).toEqual([]);
    for (const [address, reason] of Object.entries(ALLOWED)) expect(reason.length, address).toBeGreaterThan(10);
  });
});
