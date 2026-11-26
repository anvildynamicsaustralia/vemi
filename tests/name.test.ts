import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { ROOT } from "./walk.js";

/**
 * The product is VEMI, a virtual enterprise management interface (Andy, 2026-09-14). The
 * old codename is gone from every file in the tree, the records of past efforts included.
 * Commit messages keep it: rewriting them would change every hash.
 *
 * Long base64 runs are skipped, because data embedded in the standalone prototype carries
 * those three letters by chance. The pattern is assembled so this file does not match itself.
 */

const OLD = new RegExp(["s", "n", "w"].join(""), "i");
const BASE64_RUN = /[A-Za-z0-9+/=]{60,}/g;
const SKIP = new Set(["node_modules", ".git", "dist", "coverage", ".wrangler", ".idea", "data"]);

function everyFile(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (SKIP.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) everyFile(full, out);
    else out.push(full);
  }
  return out;
}

describe("the name", () => {
  it("is VEMI, and the old codename appears in no file or path", () => {
    const hits: string[] = [];
    for (const file of everyFile(ROOT)) {
      const path = relative(ROOT, file).split(sep).join("/");
      if (OLD.test(path)) hits.push(`${path} (path)`);
      const bytes = readFileSync(file);
      if (bytes.includes(0)) continue;
      for (const [n, line] of bytes.toString("utf8").split(/\r?\n/).entries()) {
        if (OLD.test(line.replace(BASE64_RUN, ""))) hits.push(`${path}:${n + 1}`);
      }
    }
    expect(hits).toEqual([]);
  });
});
