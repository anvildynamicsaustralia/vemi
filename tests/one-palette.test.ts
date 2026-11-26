import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isTestCode, ROOT, walk } from "./walk.js";

/**
 * VEMI-006: one palette, decided in one table. A colour is named in
 * `src/shared/theme.ts` and nowhere else; the stylesheet reads it back through a
 * `--vemi-*` property, and no component carries a hex. The `--vemi-on-map-*` set that
 * forced the map black is gone.
 *
 * VEMI-013 (design): dark mode is decided, as a second table in the same file, switched by
 * the `data-theme` attribute. The attribute and the dark media query may be named only in
 * the token files, which write and choose it; no other file reads or switches a theme.
 */

/** A literal: a hex, or an rgb() with numbers in it. `rgba(${r}, …)` built from a token is not one. */
const COLOUR = /#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{3}\b|\brgba?\(\s*\d/;
const TABLE = "src/shared/theme.ts";
/** The web files that write or choose the theme attribute. Nothing else may name it. */
/** The theme attribute or the dark media query, however the query is spaced. */
const THEME_SWITCH = /data-theme|prefers-color-scheme:\s*dark/;
const TOKEN_FILES = ["src/web/theme.ts", "src/web/appearance.ts"];

/** The text with comments taken out, so a sentence about a colour is not a colour. */
const code = (text: string): string => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

describe("one palette", () => {
  it("names a colour only in the theme table", () => {
    const sources = walk("src", [".ts", ".tsx"])
      .filter((f) => !isTestCode(f) && f !== TABLE);
    const hits = sources.filter((f) => COLOUR.test(code(readFileSync(join(ROOT, f), "utf8"))));
    expect(hits).toEqual([]);
  });

  // The shadows, the scrim and the hover wash were raw ink, accent and white in the
  // root block, so a token edited at runtime left every shadow in the old colour. They are
  // mixed from the tokens now, and the stylesheet names no colour of its own anywhere.
  it("names no raw colour in the stylesheet, not even in its root block", () => {
    const css = code(readFileSync(join(ROOT, "src/web/app.css"), "utf8"));
    const hits = css.split("\n").filter((line) => COLOUR.test(line));
    expect(hits).toEqual([]);
  });

  it("has no on-map override set and no old theme attribute", () => {
    const files = [...walk("src/web", [".ts", ".tsx", ".css"]), "index.html"].filter((f) => !isTestCode(f));
    const hits = files.filter((f) => /--vemi-on-map-[a-z]|data-vemi-theme/.test(code(readFileSync(join(ROOT, f), "utf8"))));
    expect(hits).toEqual([]);
  });

  it("names the theme attribute and the dark media query only in the token files", () => {
    const files = [...walk("src/web", [".ts", ".tsx", ".css"]), "index.html"]
      .filter((f) => !isTestCode(f) && !TOKEN_FILES.includes(f));
    const hits = files.filter((f) => THEME_SWITCH.test(code(readFileSync(join(ROOT, f), "utf8"))));
    expect(hits).toEqual([]);
  });

  it("catches the dark media query with or without a space after the colon", () => {
    expect(THEME_SWITCH.test("@media (prefers-color-scheme: dark) { a { color: red } }")).toBe(true);
    expect(THEME_SWITCH.test("@media (prefers-color-scheme:dark) { a { color: red } }")).toBe(true);
    expect(THEME_SWITCH.test("@media (prefers-color-scheme: light) { a { color: red } }")).toBe(false);
  });
});
