import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT, publicRootDocs, walk } from "./walk.js";

/**
 * VEMI-002 decision 39's vocabulary survives into VEMI-003 (design decisions: "the
 * vocabulary from VEMI-002 survives"). The old words stay banned from the tree, and the
 * ban is checked against the tree rather than trusted to a habit.
 *
 * Each banned word has a homonym somewhere, which is why this was never a
 * find-and-replace. The allowances are the ordinary-English uses that are not the
 * product's.
 */

/** Every root markdown file a visitor reads; the internal ones are left out as scan-em-dash.mjs leaves them out. */
const PUBLIC_ROOT_DOCS = publicRootDocs();

const BANNED: readonly { word: string; now: string; allowed: readonly string[] }[] = [
  { word: "hot", now: "in hand", allowed: [] },
  { word: "unwatched", now: "by hand", allowed: [] },
  { word: "cluster", now: "venture", allowed: [] },
  { word: "anchor", now: "tied to", allowed: [] },
  { word: "stale", now: "out of sight", allowed: ["stale-while-revalidate"] },
  { word: "strip", now: "needs you", allowed: ["stripped", "stripping"] },
];

describe("the vocabulary, decision 39", () => {
  const files = [
    ...walk("migrations", [".sql"]),
    "wrangler.jsonc",
    ...walk("src", [".ts", ".tsx", ".css", ".json"]),
    ...walk("tests", [".ts"]),
    ...(existsSync(join(ROOT, "docs")) ? walk("docs", [".md"]) : []),
    ...PUBLIC_ROOT_DOCS, ".works/efforts/VEMI-013_release/DEPLOY.md",
  ].filter((f) => !f.endsWith("vocabulary.test.ts"));

  it("finds files to scan", () => {
    expect(files.length).toBeGreaterThan(20);
  });

  for (const { word, now, allowed } of BANNED) {
    it(`says "${now}" and never "${word}"`, () => {
      const pattern = new RegExp(`\\b${word}\\b`, "i");
      const hits: string[] = [];
      for (const file of files) {
        for (const [n, line] of readFileSync(join(ROOT, file), "utf8").split(/\r?\n/).entries()) {
          if (!pattern.test(line)) continue;
          const lower = line.toLowerCase();
          if (allowed.some((ok) => lower.includes(ok))) continue;
          hits.push(`${file}:${n + 1}: ${line.trim().slice(0, 100)}`);
        }
      }
      expect(hits, `"${word}" is now "${now}"`).toEqual([]);
    });
  }
});
