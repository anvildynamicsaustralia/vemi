import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "./walk.js";

/**
 * docs/privacy.md says what is stored and where. Every length of time it states is read
 * back from the constant in the code that sets it, so a page and the code cannot drift.
 */

const EM_DASH = String.fromCharCode(0x2014);
const source = (rel: string): string => readFileSync(join(ROOT, rel), "utf8");
const PAGE = existsSync(join(ROOT, "docs", "privacy.md")) ? source("docs/privacy.md") : "";
const flat = PAGE.replace(/\s+/g, " ").toLowerCase();
const SMALL: Readonly<Record<string, number>> = { one: 1, two: 2, three: 3, five: 5, seven: 7, ten: 10 };

/** Each time the code sets, as a number. */
function constants(): { invite: number; deletion: number; back: number; handOver: number } {
  const identity = source("src/api/accountIdentity.ts");
  const invite = /invite:\s*(\d+)\s*\*\s*DAY/.exec(identity);
  const handOver = /MOVE_IN_LIFETIME\s*=\s*(\d+)\s*\*\s*MINUTE/.exec(identity);
  const purge = /every account whose (\w+) days after asking/.exec(source("src/api/accountPurge.ts").replace(/\s*\n\s*\*\s*/g, " "));
  const back = /const BACK_DAYS\s*=\s*(\d+)/.exec(source("src/api/selfUpdate.ts"));
  if (invite === null || handOver === null || purge === null || back === null) throw new Error("a constant moved");
  return { invite: Number(invite[1]), handOver: Number(handOver[1]), deletion: SMALL[purge[1] ?? ""] ?? Number.NaN, back: Number(back[1]) };
}

const sentences = (): string[] => flat.split(/(?<=[.!?])\s+/);
const sentencesWith = (word: string): string[] => sentences().filter((s) => s.includes(word));

/** Every "N days" or "N minutes" in the sentences, as [number, unit]. */
function spans(list: string[]): Array<[number, string]> {
  const found: Array<[number, string]> = [];
  for (const s of list) {
    for (const m of s.matchAll(/\b(\d+|one|two|three|five|seven|ten)[ -](day|minute|hour)s?\b/g)) {
      found.push([SMALL[m[1] ?? ""] ?? Number(m[1]), m[2] ?? ""]);
    }
  }
  return found;
}

describe("docs/privacy.md", () => {
  it("exists and its first line is the date it was last checked against the code", () => {
    expect(PAGE, "docs/privacy.md is there").not.toBe("");
    const first = PAGE.split(/\r?\n/)[0] ?? "";
    expect(first).toMatch(/^Last checked against the code: \d{1,2} (January|February|March|April|May|June|July|August|September|October|November|December) \d{4}\.$/);
  });

  it("has one top heading and no em-dash", () => {
    expect(PAGE.split(/\r?\n/).filter((l) => /^# /.test(l)).length).toBe(1);
    expect(PAGE.includes(EM_DASH)).toBe(false);
  });

  it("states each length of time as the code sets it", () => {
    const k = constants();
    const wants: Array<[string, number, string]> = [
      ["delete my account", k.deletion, "day"],
      ["go back", k.back, "day"],
      ["invite link", k.invite, "day"],
      ["hand-over", k.handOver, "minute"],
    ];
    for (const [word, n, unit] of wants) {
      const found = spans(sentencesWith(word));
      expect(found.length, `a sentence about "${word}" gives its time`).toBeGreaterThan(0);
      for (const [num, u] of found) expect([num, u], `"${word}"`).toEqual([n, unit]);
    }
  });

  it("names no time the code does not set", () => {
    const k = constants();
    const allowed = new Set([`${k.deletion} day`, `${k.back} day`, `${k.invite} day`, `${k.handOver} minute`]);
    for (const [num, unit] of spans(sentences())) {
      expect(allowed.has(`${num} ${unit}`), `${num} ${unit}`).toBe(true);
    }
  });

  it("covers the three ways in, with what is stored and where", () => {
    for (const word of ["local mode", "a copy of your own", "someone else's copy", "never leaves", "cloudflare", "encrypts data at rest", "in transit"]) {
      expect(flat, word).toContain(word);
    }
  });

  it("says whoever runs a copy could read what is not locked, and what stops it", () => {
    expect(flat).toContain("whoever runs a copy runs the cloudflare space");
    expect(flat).toContain("could technically read");
    expect(flat).toContain("locked notes");
    expect(flat).toContain("full account encryption");
  });

  it("says the setup key's path, limits and end", () => {
    expect(flat).toContain("setup key");
    expect(flat).toContain("only if the relay is used");
    expect(flat).toContain("never stored or logged");
    expect(flat).toContain("keeps it encrypted in its own database");
    expect(flat).toContain("vemi setup");
    // The helper shows a link to take the key away by hand. It does not delete the key itself.
    expect(flat).not.toMatch(/the (setup )?helper (deletes|removes)/);
  });

  it("says releases are signed and unsigned ones are refused", () => {
    expect(flat).toContain("signed");
    expect(flat).toMatch(/unsigned[^.]*refused/);
  });

  it("uses the words of the screens for locking and for full account encryption", () => {
    for (const word of ["app lock", "recovery key", "privacy and security", "turn on", "search runs on your devices", "reminders show titles only on your devices"]) {
      expect(flat, word).toContain(word);
    }
    expect(flat).toContain("structure, dates and reminder times");
    expect(flat).toContain("can't read this account");
    expect(flat).toContain("nobody can get your data back");
  });

  it("says VEMI sends no email and calls no model", () => {
    expect(flat).toContain("sends no email");
    expect(flat).toContain("calls no model");
  });

  it("carries the note for the reader of the repo, and names no person or planning folder", () => {
    expect(PAGE).toContain("This page was written from the code and has not been through a lawyer.");
    expect(/\bandy\b/i.test(PAGE)).toBe(false);
    expect(PAGE.includes(".works")).toBe(false);
    expect(/@[\w.-]+\.\w+/.test(PAGE)).toBe(false);
  });

  it("is linked from the index and holds no word of the old vocabulary", () => {
    expect(source("docs/index.md")).toContain("(privacy.md)");
    expect(/\bventures?\b/i.test(PAGE)).toBe(false);
  });
});
