import { describe, expect, it } from "vitest";
import {
  UNKNOWN, readFirstRun, storedFirstRun, tipDue, toStoredFirstRun, withStep, withTipSeen,
} from "./firstRunState.js";

describe("reading an answer", () => {
  it("takes a step 1 to 7 and a list of tip names", () => {
    expect(readFirstRun({ step: 3, tipsSeen: ["map"] })).toEqual({ step: 3, tipsSeen: ["map"], known: true });
  });
  it("reads null as over, and null tips as none to show", () => {
    expect(readFirstRun({ step: null, tipsSeen: null })).toEqual({ step: null, tipsSeen: null, known: true });
  });
  it("drops what is not a step or a tip name", () => {
    expect(readFirstRun({ step: 9, tipsSeen: ["ok", "Bad Name", 4] })).toEqual({ step: null, tipsSeen: ["ok"], known: true });
  });
  it("gives unknown for anything that is not an object", () => {
    for (const v of [null, undefined, 4, "x", []]) expect(readFirstRun(v)).toBe(UNKNOWN);
  });
});

describe("resuming from a kept answer", () => {
  it("returns the step that was kept", () => {
    const kept = toStoredFirstRun({ step: 4, tipsSeen: [], known: true });
    expect(storedFirstRun(kept)).toEqual({ step: 4, tipsSeen: [], known: true });
  });
  it("is unknown for nothing kept or a broken copy", () => {
    expect(storedFirstRun(null)).toBe(UNKNOWN);
    expect(storedFirstRun("{nope")).toBe(UNKNOWN);
  });
});

describe("changes", () => {
  it("moves the step and ends with null", () => {
    expect(withStep(UNKNOWN, 2)).toEqual({ step: 2, tipsSeen: null, known: true });
    expect(withStep({ step: 6, tipsSeen: [], known: true }, null).step).toBeNull();
  });
  it("appends a tip once and ignores repeats, bad names and no tips to show", () => {
    const s = { step: null, tipsSeen: ["map"], known: true } as const;
    expect(withTipSeen(s, "today").tipsSeen).toEqual(["map", "today"]);
    expect(withTipSeen(s, "map")).toBe(s);
    expect(withTipSeen(s, "Bad Name")).toBe(s);
    const none = { step: null, tipsSeen: null, known: true } as const;
    expect(withTipSeen(none, "map")).toBe(none);
  });
  it("keeps at most 20 tips", () => {
    const names = Array.from({ length: 20 }, (_, i) => `t${"abcdefghijklmnopqrst"[i]}`);
    const s = { step: null, tipsSeen: names, known: true };
    const next = withTipSeen(s, "extra");
    expect(next.tipsSeen).toHaveLength(20);
    expect(next.tipsSeen?.at(-1)).toBe("extra");
  });
});

describe("tipDue", () => {
  it("is true only for an account with tips to show that has not seen this one", () => {
    expect(tipDue({ step: null, tipsSeen: [], known: true }, "map")).toBe(true);
    expect(tipDue({ step: null, tipsSeen: ["map"], known: true }, "map")).toBe(false);
    expect(tipDue({ step: null, tipsSeen: null, known: true }, "map")).toBe(false);
    expect(tipDue(UNKNOWN, "map")).toBe(false);
  });
});
