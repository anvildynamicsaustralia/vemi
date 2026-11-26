import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { describe, expect, it } from "vitest";
import { ROOT, walk } from "./walk.js";

/**
 * The pictures in docs/images: each is a small PNG, each is used by a page, and each picture a
 * page names is there. Reads files only. The pictures are made by e2e/docs-shots.spec.ts.
 */

const IMAGES = join(ROOT, "docs", "images");
const MAX_BYTES = 300 * 1024;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const IMAGE_LINK = /!\[([^\]]*)\]\(\s*<?([^)\s>]+)>?[^)]*\)/g;

const pictures = (): string[] => (existsSync(IMAGES) ? readdirSync(IMAGES).filter((f) => f.endsWith(".png")).sort() : []);

/** The pages: the README and every Markdown file under docs. */
const pages = (): string[] => ["README.md", ...(existsSync(join(ROOT, "docs")) ? walk("docs", [".md"]) : [])].filter((p) => existsSync(join(ROOT, p)));

interface Use { readonly page: string; readonly line: number; readonly alt: string; readonly target: string }

function uses(): Use[] {
  const out: Use[] = [];
  for (const page of pages()) {
    readFileSync(join(ROOT, page), "utf8").split(/\r?\n/).forEach((text, i) => {
      for (const m of text.matchAll(IMAGE_LINK)) out.push({ page, line: i + 1, alt: (m[1] ?? "").trim(), target: (m[2] ?? "").split("#")[0] ?? "" });
    });
  }
  return out;
}

/** A local image link as a root-relative path, or null for an address on the web. */
function local(use: Use): string | null {
  if (/^[a-z][a-z0-9+.-]*:/i.test(use.target)) return null;
  return relative(ROOT, resolve(dirname(join(ROOT, use.page)), decodeURIComponent(use.target))).split(sep).join("/");
}

describe("docs pictures", () => {
  it("keeps each picture a PNG under 300 KB", () => {
    const bad: string[] = [];
    for (const file of pictures()) {
      const path = join(IMAGES, file);
      if (statSync(path).size > MAX_BYTES) bad.push(`docs/images/${file}: over 300 KB`);
      if (!readFileSync(path).subarray(0, 8).equals(PNG_SIGNATURE)) bad.push(`docs/images/${file}: not a PNG`);
    }
    expect(bad).toEqual([]);
  });

  it("holds only PNG files", () => {
    const other = existsSync(IMAGES) ? readdirSync(IMAGES).filter((f) => !f.endsWith(".png")) : [];
    expect(other).toEqual([]);
  });

  it("has a picture for every picture a page names", () => {
    const missing = uses().filter((u) => {
      const at = local(u);
      return at !== null && !existsSync(join(ROOT, at));
    }).map((u) => `${u.page}:${u.line}: ${u.target} is missing`);
    expect(missing).toEqual([]);
  });

  it("has a page for every picture, once there are pages under docs", () => {
    if (pages().every((p) => p === "README.md")) return;
    const named = new Set(uses().map(local));
    const loose = pictures().filter((f) => !named.has(`docs/images/${f}`)).map((f) => `docs/images/${f}: no page uses it`);
    expect(loose).toEqual([]);
  });

  it("gives every image link alt text", () => {
    const bare = uses().filter((u) => u.alt === "").map((u) => `${u.page}:${u.line}: image without alt text`);
    expect(bare).toEqual([]);
  });

  it("has the eight pictures the pages use", () => {
    const want = ["map-desk", "map-phone", "today-desk", "today-phone", "project-desk", "search-desk", "first-run-phone", "account-phone"].map((n) => `${n}.png`);
    expect(pictures()).toEqual(expect.arrayContaining(want));
  });
});
