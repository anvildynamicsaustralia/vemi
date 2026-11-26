import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT, isTestCode, walk } from "./walk.js";

/**
 * The foundation brief: *no file outside the data-access layer imports or references the
 * D1 binding.* The exit path from Cloudflare is one file or it does not exist, so this is
 * checked against the tree rather than trusted to a habit.
 *
 * Test code is exempt by name, and only because it has to stand up a real D1 for the
 * store to run against. It is not on any request path.
 */

const DATA_LAYER = "src/api/store.ts";

const BINDING = [
  /\bD1Database\b/,
  /\bD1PreparedStatement\b/,
  /\bD1Result\b/,
  /\bD1Response\b/,
  /\bD1Meta\b/,
  /\.DB\b/,
  /\{\s*DB\s*[,}]/,
  /["']DB["']/,
];

/**
 * The one exemption. The setup build gives a new copy's Worker its D1 binding by name, so the
 * name has to be written once where it is set. That file reads no data through it. The exemption
 * covers the quoted name only, in that file only, and only on the one line that sets the constant;
 * any other match in the file still fails.
 */
const EXEMPT = {
  file: "src/shared/setup/buildSteps.ts",
  pattern: /["']DB["']/,
  line: /^export const DATA_BINDING = "DB";$/,
};

describe("the D1 binding lives in one file", () => {
  const files = [...walk("scripts", [".ts", ".tsx", ".js", ".mjs"]), ...walk("src", [".ts", ".tsx", ".js", ".mjs"])]
    .filter((f) => !isTestCode(f));

  it("finds application source to scan", () => {
    expect(files).toContain(DATA_LAYER);
    expect(files.length).toBeGreaterThan(5);
  });

  it("is named by the data-access layer", () => {
    const text = readFileSync(join(ROOT, DATA_LAYER), "utf8");
    expect(BINDING.filter((p) => p.test(text)).length).toBeGreaterThan(0);
  });

  it("is named by nothing else", () => {
    const hits: string[] = [];
    for (const file of files) {
      if (file === DATA_LAYER) continue;
      const text = readFileSync(join(ROOT, file), "utf8");
      for (const pattern of BINDING) {
        if (file === EXEMPT.file && pattern.source === EXEMPT.pattern.source) {
          // Every line that matches must be the one line the exemption names.
          const stray = text.split("\n").filter((l) => pattern.test(l) && !EXEMPT.line.test(l.trimEnd()));
          if (stray.length > 0) hits.push(`${file} -> ${pattern.source}: ${stray[0]}`);
          continue;
        }
        if (pattern.test(text)) hits.push(`${file} -> ${pattern.source}`);
      }
    }
    expect(hits).toEqual([]);
  });

  it("keeps the exemption to the one line, and the line is there", () => {
    const text = readFileSync(join(ROOT, EXEMPT.file), "utf8");
    expect(text.split("\n").filter((l) => EXEMPT.line.test(l.trimEnd()))).toHaveLength(1);
  });
});
