import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT, isTestCode, walk } from "./walk.js";

/**
 * Milestone dates are soft. The brief: *nothing here or in any later phase may compute
 * lateness, overdue-ness or a red state from it. Overdue exists in exactly one place: a
 * task with an explicit date, in the today view.*
 *
 * A milestone's date may be stored, returned and ordered by. It may not sit beside a
 * comparison or a clock, and `overdue` may be spoken only where today is built.
 */

const SOURCE = [...walk("migrations", [".sql"]), ...walk("src", [".ts", ".tsx"])].filter((f) => !isTestCode(f));

/** The client shows the flag the Worker sends. It may say the word; it may not work it out. */
const CLIENT = SOURCE.filter((f) => f.startsWith("src/web/"));

describe("a milestone date", () => {
  it("is never compared with anything or read against a clock", () => {
    const hits: string[] = [];
    for (const file of SOURCE) {
      for (const [n, line] of readFileSync(join(ROOT, file), "utf8").split(/\r?\n/).entries()) {
        if (!/aiming_?on/i.test(line)) continue;
        // Prose about the rule is not the rule being broken.
        if (/^\s*(\*|\/\/|--)/.test(line)) continue;
        const compared = /aiming_?on["'`]?\s*(<|>|<=|>=|BETWEEN)|(<|>|<=|>=)\s*[\w.]*aiming_?on/i;
        // `\bdate\(` is SQL's date(); a formatter named `shortDate(` only writes a date down.
        const clocked = /julianday|\bdate\(|strftime|Date\.now|new Date|getTime|overdue|\blate\b/i;
        if (compared.test(line) || clocked.test(line)) {
          hits.push(`${file}:${n + 1}: ${line.trim()}`);
        }
      }
    }
    expect(hits).toEqual([]);
  });
});

describe("overdue", () => {
  it("is spoken only by the model's today type, the one query that builds today, and the client showing it", () => {
    const allowed = new Set(["src/shared/model.ts", "src/api/store.ts", ...CLIENT]);
    const speaking = SOURCE.filter((f) => /overdue/i.test(readFileSync(join(ROOT, f), "utf8")));
    expect(speaking.filter((f) => !allowed.has(f))).toEqual([]);
  });

  it("is never worked out by the client: a task's date is shown, not compared", () => {
    const hits: string[] = [];
    for (const file of CLIENT) {
      for (const [n, line] of readFileSync(join(ROOT, file), "utf8").split(/\r?\n/).entries()) {
        if (!/dueOn/.test(line)) continue;
        if (/^\s*(\*|\/\/)/.test(line)) continue;
        const compared = /dueOn\s*(<|>|<=|>=)(?!=)|(<|>|<=|>=)\s*[\w.?]*dueOn|Date\.now|new Date|getTime/;
        if (compared.test(line)) hits.push(`${file}:${n + 1}: ${line.trim()}`);
      }
    }
    expect(hits).toEqual([]);
  });

  it("appears in the store only inside today()", () => {
    const lines = readFileSync(join(ROOT, "src/api/store.ts"), "utf8").split(/\r?\n/);
    const start = lines.findIndex((l) => l.includes("async today("));
    const end = lines.findIndex((l, n) => n > start && /^\s+async \w+\(/.test(l));
    expect(start).toBeGreaterThan(0);
    for (const [n, line] of lines.entries()) {
      if (/overdue/i.test(line)) expect(n > start && n < end, `store.ts:${n + 1}`).toBe(true);
    }
  });
});
