import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isTestCode, ROOT, walk } from "./walk.js";

/**
 * Chips, sheets and the undo notice are drawn once, by `ui/Chip.tsx`, `ui/Sheet.tsx` and
 * `ui/Notice.tsx`, and every screen uses those. A screen that writes the class itself is
 * a second chip, and the two drift (VEMI-013 design, task 4).
 */
const screens = walk("src/web", [".tsx"]).filter((f) => !isTestCode(f));

/** The lines of `file` that set a className holding `word` as a whole class, not a prefix. */
function drawing(file: string, word: string): string[] {
  const whole = new RegExp(`(^|[\\s"\`])${word}(?![-\\w])`);
  const value = /className=(?:"([^"]*)"|\{`([^`]*)`\})/g;
  return readFileSync(join(ROOT, file), "utf8")
    .split("\n")
    .filter((line) => [...line.matchAll(value)].some((m) => whole.test(m[1] ?? m[2] ?? "")));
}

describe.each([
  ["chip", "src/web/ui/Chip.tsx"],
  ["sheet", "src/web/ui/Sheet.tsx"],
  ["notice", "src/web/ui/Notice.tsx"],
])("the shared %s", (word, home) => {
  it("exists", () => {
    expect(() => readFileSync(join(ROOT, home), "utf8")).not.toThrow();
  });

  it("is the only place that writes its class", () => {
    const offenders = screens.filter((f) => f !== home).flatMap((f) => drawing(f, word).map((l) => `${f}: ${l.trim()}`));
    expect(offenders).toEqual([]);
  });
});
