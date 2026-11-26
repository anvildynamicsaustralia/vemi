import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "./walk.js";

/**
 * Reads a JSONC file for the config guard tests (VEMI-010 move phase: the staging and moved
 * config tests share it). `//` line comments only, which is all the Wrangler config uses.
 */

/** Drops `//` line comments from JSONC text, respecting quoted strings (URLs carry `//` too). */
export function withoutLineComments(text: string): string {
  let out = "";
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
      continue;
    }
    out += ch;
  }
  return out;
}

/** Reads a repo-relative JSONC file as `T`. */
export function readJsonc<T>(path: string): T {
  return JSON.parse(withoutLineComments(readFileSync(join(ROOT, path), "utf8"))) as T;
}
