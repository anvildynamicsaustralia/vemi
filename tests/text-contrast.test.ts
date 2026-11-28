import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT, walk } from "./walk.js";

/**
 * Text in the accent reads `--vemi-live-text`, never `--vemi-live`. The bright accent is 3.5:1 on
 * white, under the 4.5:1 that small text needs; live-text is the accent's darker press colour on
 * light and its lighter one on dark, so it passes in both themes and every accent. Only the big
 * headline accents keep the bright one: large text needs 3:1.
 */
const LARGE = [".gate-side-head em", ".landing-title em", ".get-headline em", ".first-run-card-icon"];

describe("accent text", () => {
  it("is written in live-text, except for the big headline accents", () => {
    const hits: string[] = [];
    for (const file of walk("src/web", [".css"])) {
      const text = readFileSync(join(ROOT, file), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
      text.split("\n").forEach((line, i) => {
        if (/(?<![-\w])color: var\(--vemi-live\)/.test(line) && !LARGE.some((s) => line.includes(s))) hits.push(`${file}:${i + 1}`);
      });
    }
    expect(hits).toEqual([]);
  });
});
