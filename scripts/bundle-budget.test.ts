import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { runBudget } from "./bundle-budget.mjs";

/**
 * The bundle budget, against small fake `dist/web` trees in a temp folder. A fake page names
 * its files; the recorded figure is the real gzip size of what the page loads.
 */

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** Noise that does not compress, so a file's gzip size grows with the length asked for. */
const noise = (length: number, seed = 1): string => {
  let state = seed;
  let out = "";
  for (let i = 0; i < length; i += 1) {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    out += String.fromCharCode(97 + ((state >> 8) % 26));
  }
  return out;
};
const gz = (text: string): number => gzipSync(text, { level: 9 }).length;

function tree(files: Record<string, string>, html: string | null): string {
  const root = mkdtempSync(join(tmpdir(), "budget-"));
  roots.push(root);
  const all: Record<string, string> = { ...files };
  if (html !== null) all["dist/web/index.html"] = html;
  for (const [name, body] of Object.entries(all)) {
    const path = join(root, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, body);
  }
  return root;
}

const PAGE = `<!doctype html><html><head>
<script type="module" crossorigin src="/assets/main-abc.js"></script>
<link rel="modulepreload" crossorigin href="/assets/react-abc.js">
<link rel="stylesheet" crossorigin href="/assets/main-abc.css">
</head><body><div id="root"></div></body></html>`;
const FILES: Record<string, string> = {
  "dist/web/assets/main-abc.js": noise(4000, 1),
  "dist/web/assets/react-abc.js": noise(3000, 2),
  "dist/web/assets/main-abc.css": noise(1000, 3),
  "dist/web/assets/font-abc.woff2": noise(9000, 4),
};
const SUM =
  gz(FILES["dist/web/assets/main-abc.js"] as string) +
  gz(FILES["dist/web/assets/react-abc.js"] as string) +
  gz(FILES["dist/web/assets/main-abc.css"] as string);
const FIGURE_FILE = "scripts/bundle-budget.json";

function withFigure(figure: number, files: Record<string, string> = FILES, html: string = PAGE): string {
  const json = JSON.stringify({ gzipBytes: figure, recordedOn: "2026-11-22", reason: "first recorded figure" });
  return tree({ ...files, [FIGURE_FILE]: json }, html);
}
const run = (root: string, args: string[] = []) => runBudget({ root, args, today: "2026-11-23" });
const figureOf = (root: string): number => JSON.parse(readFileSync(join(root, FIGURE_FILE), "utf8")).gzipBytes;

describe("the check", () => {
  it("passes when the entry equals the recorded figure", () => {
    const result = run(withFigure(SUM));
    expect(result.code).toBe(0);
    expect(result.text).toContain(String(SUM));
  });

  it("passes at exactly 5.0 percent over", () => {
    // One script whose gzip size is exactly 2100 bytes, against a recorded 2000.
    let body = noise(2000, 5);
    while (gz(body) < 2100) body += noise(1, body.length);
    expect(gz(body)).toBe(2100);
    const page = `<!doctype html><html><head><script type="module" src="/assets/only-abc.js"></script></head></html>`;
    expect(run(withFigure(2000, { "dist/web/assets/only-abc.js": body }, page)).code).toBe(0);
    expect(run(withFigure(1990, { "dist/web/assets/only-abc.js": body }, page)).code).not.toBe(0);
  });

  it("fails at 5.1 percent over and prints both numbers and the percentage", () => {
    const recorded = Math.floor(SUM / 1.051);
    const result = run(withFigure(recorded));
    expect(result.code).not.toBe(0);
    expect(result.text).toContain(String(SUM));
    expect(result.text).toContain(String(recorded));
    expect(result.text).toMatch(/5\.\d%/);
  });

  it("passes when smaller, and says it is under", () => {
    const result = run(withFigure(SUM * 2));
    expect(result.code).toBe(0);
    expect(result.text).toMatch(/under/);
  });

  it("fails when the recorded file is missing", () => {
    expect(run(tree(FILES, PAGE)).code).not.toBe(0);
  });

  it("fails when the recorded file does not parse", () => {
    expect(run(tree({ ...FILES, [FIGURE_FILE]: "{ not json" }, PAGE)).code).not.toBe(0);
  });

  it("fails when the recorded file holds no number", () => {
    const json = JSON.stringify({ recordedOn: "x", reason: "y" });
    expect(run(tree({ ...FILES, [FIGURE_FILE]: json }, PAGE)).code).not.toBe(0);
  });

  it("fails when dist/web/index.html is missing", () => {
    const json = JSON.stringify({ gzipBytes: 10, recordedOn: "x", reason: "y" });
    expect(run(tree({ [FIGURE_FILE]: json }, null)).code).not.toBe(0);
  });

  it("fails when index.html references no script, never passing by finding nothing", () => {
    const page = `<!doctype html><html><head><link rel="stylesheet" href="/assets/main-abc.css"></head></html>`;
    const result = run(withFigure(10, FILES, page));
    expect(result.code).not.toBe(0);
    expect(result.text).toMatch(/no script/);
  });

  it("fails when a referenced file is missing", () => {
    const rest = { ...FILES };
    delete rest["dist/web/assets/react-abc.js"];
    expect(run(withFigure(SUM, rest)).code).not.toBe(0);
  });

  it("counts a second referenced asset", () => {
    const page = PAGE.replace("</head>", `<script type="module" src="/assets/extra-abc.js"></script></head>`);
    const extra = randomBytes(5000).toString("base64");
    const files = { ...FILES, "dist/web/assets/extra-abc.js": extra };
    const result = run(withFigure(SUM, files, page));
    expect(result.code).not.toBe(0);
    expect(result.text).toContain(String(SUM + gz(extra)));
  });

  it("does not count a font the page does not reference", () => {
    // The font sits in the tree and the measured sum is still the three the page names.
    expect(run(withFigure(SUM)).text).toContain(`${SUM} bytes`);
  });
});

describe("--record", () => {
  it("writes the figure with its reason and the date", () => {
    const root = tree(FILES, PAGE);
    const result = run(root, ["--record", "first recorded figure"]);
    expect(result.code).toBe(0);
    expect(JSON.parse(readFileSync(join(root, FIGURE_FILE), "utf8"))).toEqual({
      gzipBytes: SUM,
      recordedOn: "2026-11-23",
      reason: "first recorded figure",
    });
  });

  it("refuses an empty reason", () => {
    const root = tree(FILES, PAGE);
    expect(run(root, ["--record", "   "]).code).not.toBe(0);
    expect(run(root, ["--record"]).code).not.toBe(0);
  });

  it("refuses to raise the figure by more than 5 percent on the old reason", () => {
    const old = Math.floor(SUM / 1.2);
    const root = withFigure(old);
    expect(run(root, ["--record", "first recorded figure"]).code).not.toBe(0);
    expect(figureOf(root)).toBe(old);
  });

  it("allows a raise past 5 percent when the reason is new text", () => {
    const root = withFigure(Math.floor(SUM / 1.2));
    expect(run(root, ["--record", "the calendar sheet joined the entry"]).code).toBe(0);
    expect(figureOf(root)).toBe(SUM);
  });

  it("allows a lower figure", () => {
    const root = withFigure(SUM * 2);
    expect(run(root, ["--record", "split the map"]).code).toBe(0);
    expect(figureOf(root)).toBe(SUM);
  });
});
