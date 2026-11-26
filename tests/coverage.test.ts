import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ROOT } from "./walk.js";

/**
 * `spec/coverage.md` lists every surface in the brief with what proves it. This test fails on
 * any row left `[ ]` that is not named, with an owner, in the file's `## Hand checks` list, and
 * on a ticked row that names a test file which is not there. `.works/` is not in the public
 * repo, so with the file absent the check is skipped and says so.
 */

const COVERAGE = join(ROOT, ".works", "efforts", "VEMI-013_release", "spec", "coverage.md");

/** Every problem in a coverage file's text. `exists` says whether a repo path is there. */
export function coverageProblems(text: string, exists: (path: string) => boolean): string[] {
  const problems: string[] = [];
  const lines = text.split("\n");
  const handAt = lines.findIndex((line) => /^##\s+Hand checks\s*$/.test(line));
  const hand = handAt < 0 ? [] : lines.slice(handAt + 1).filter((line) => line.startsWith("- "));
  const handOwned = (surface: string): boolean =>
    hand.some((line) => {
      const item = line.slice(2);
      if (!item.startsWith(surface)) return false;
      const rest = item.slice(surface.length).trim();
      return rest.startsWith(":") && rest.slice(1).trim().length > 0;
    });

  for (const [index, line] of lines.entries()) {
    const done = /\|\s*\[( |x)\]\s*\|\s*$/.exec(line);
    if (!line.startsWith("|") || !done) continue;
    const surface = (line.split("|")[1] ?? "").trim();
    if (done[1] === " ") {
      if (!handOwned(surface)) problems.push(`line ${index + 1}: "${surface}" is [ ] and is not on the hand checks list with an owner`);
      continue;
    }
    for (const match of line.matchAll(/`((?:src|e2e|tests|scripts)\/[A-Za-z0-9_./-]+\.(?:ts|tsx|mjs))`/g)) {
      const path = match[1] ?? "";
      if (!exists(path)) problems.push(`line ${index + 1}: "${surface}" names ${path}, which is not there`);
    }
  }
  return problems;
}

const present = existsSync(COVERAGE);
const repoHas = (path: string): boolean => existsSync(join(ROOT, path));

describe("coverage.md", () => {
  it("finds an open row that has no owner, and a ticked row that names a missing test", () => {
    const dir = mkdtempSync(join(tmpdir(), "vemi-coverage-"));
    try {
      const file = join(dir, "coverage.md");
      const head = ["| Surface | Route | API calls | Tests | Done |", "|---|---|---|---|---|"];
      const rows = [
        "| Alpha | `/` | none | `tests/walk.ts` | [x] |",
        "| Beta | `/b` | none | `tests/not-there.test.ts` | [x] |",
        "| Gamma | `/g` | none | | [ ] |",
        "| Delta | `/d` | none | | [ ] |",
      ];
      writeFileSync(file, `# Coverage\n\n${[...head, ...rows].join("\n")}\n\n## Hand checks\n\n- Gamma: Andy (by eye)\n- Delta:\n`);
      const found = coverageProblems(readFileSync(file, "utf8"), repoHas);
      expect(found).toHaveLength(2);
      expect(found.join("\n")).toContain("Beta");
      expect(found.join("\n")).toContain("tests/not-there.test.ts");
      expect(found.join("\n")).toContain("Delta");
      expect(found.join("\n")).not.toContain("Gamma");

      const fixed = [rows[0], "| Beta | `/b` | none | `tests/walk.ts` | [x] |", "| Gamma | `/g` | none | | [x] |", "| Delta | `/d` | none | | [x] |"];
      writeFileSync(file, `# Coverage\n\n${[...head, ...fixed].join("\n")}\n`);
      expect(coverageProblems(readFileSync(file, "utf8"), repoHas)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.skipIf(!present)(
    "has no open row without a named hand check, and no ticked row naming a missing test (skipped when .works/ is absent)",
    () => {
      expect(coverageProblems(readFileSync(COVERAGE, "utf8"), repoHas)).toEqual([]);
    },
  );
});
