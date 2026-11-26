import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
// @ts-expect-error plain ESM script with JSDoc, no declaration file
import { buildFront } from "./build-front.mjs";

const made: string[] = [];
function project(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "front-"));
  made.push(root);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const built = {
  "dist/web/get/index.html": "<!doctype html>get",
  "dist/web/try/index.html": "<!doctype html>try",
  "dist/web/try/sw.js": "try worker",
  "dist/web/try/assets/dbWorker-1.js": "db",
  "dist/web/assets/app-1.js": "app",
  "dist/web/icons/a.svg": "<svg/>",
  "dist/web/index.html": "the app shell",
  "dist/web/sw.js": "worker",
  "dist/web/manifest.webmanifest": "{}",
  "dist/web/_headers": "/*\n  X-Frame-Options: DENY\n\n/try/*\n  ! Content-Security-Policy\n  Content-Security-Policy: default-src 'none'\n",
  "dist/release/latest.json": "{}",
  "dist/release/0.1.0/manifest.json": "{}",
  "dist/release/0.1.0/worker/index.js": "w",
};

describe("buildFront", () => {
  it("copies only what /get/ needs, with the release served as static files", () => {
    const out = buildFront(project(built)) as string;
    const files = readdirSync(out, { recursive: true, encoding: "utf8" }).map((f) => f.replaceAll("\\", "/"));
    expect(files).toContain("get/index.html");
    expect(files).toContain("try/index.html");
    expect(files).toContain("try/sw.js");
    expect(files).toContain("try/assets/dbWorker-1.js");
    expect(files).toContain("assets/app-1.js");
    expect(files).toContain("release/latest.json");
    expect(files).toContain("release/0.1.0/manifest.json");
    expect(files).toContain("release/0.1.0/worker/index.js");
    for (const left of ["index.html", "sw.js", "manifest.webmanifest"]) expect(files).not.toContain(left);
  });

  it("redirects / to /get/ as a static rule, and lets any page read the release", () => {
    const out = buildFront(project(built)) as string;
    expect(readFileSync(join(out, "_redirects"), "utf8")).toBe("/ /get/ 302\n");
    const headers = readFileSync(join(out, "_headers"), "utf8");
    expect(headers).toContain("X-Frame-Options: DENY");
    // The local page's own policy block comes with the app's headers, detaching the main one.
    expect(headers).toMatch(/\/try\/\*\n {2}! Content-Security-Policy\n {2}Content-Security-Policy: /);
    expect(headers).toMatch(/\/release\/\*\n {2}Access-Control-Allow-Origin: \*/);
  });

  it("starts clean each time", () => {
    const root = project(built);
    buildFront(root);
    writeFileSync(join(root, "dist", "front", "stale.txt"), "old");
    const out = buildFront(root) as string;
    expect(readdirSync(out)).not.toContain("stale.txt");
  });

  it("says what is missing", () => {
    expect(() => buildFront(project({}))).toThrow(/dist\/web is missing/);
    expect(() => buildFront(project({ "dist/web/index.html": "x" }))).toThrow(/get\/index.html/);
    expect(() => buildFront(project({ "dist/web/get/index.html": "x" }))).toThrow(/try\/index.html/);
    expect(() => buildFront(project({ "dist/web/get/index.html": "x", "dist/web/try/index.html": "x" }))).toThrow(/latest.json/);
  });
});
