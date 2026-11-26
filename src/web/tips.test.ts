import { describe, expect, it } from "vitest";
import { UNKNOWN, type FirstRun } from "./firstRunState.js";
import { LEVEL_PRESETS } from "./levelPresets.js";
import { DEFAULT_LEVEL_NAMES, pluralOf } from "./levelWords.js";
import { TIPS, TIP_MOST, tipFor, type Tip, type TipFacts, type TipName } from "./tips.js";

const wordsOf = (n: typeof DEFAULT_LEVEL_NAMES) => ({
  space: n.space, spaces: pluralOf(n.space), project: n.project, projects: pluralOf(n.project),
  milestone: n.milestone, milestones: pluralOf(n.milestone), task: n.task, tasks: pluralOf(n.task),
});

const over: FirstRun = { step: null, tipsSeen: [], known: true };
const facts = (over_: Partial<TipFacts> = {}): TipFacts => ({
  words: wordsOf(DEFAULT_LEVEL_NAMES), phone: false, smartDates: true, state: over, ...over_,
});
const NAMES: readonly TipName[] = ["map", "today", "project", "search", "lock"];

describe("the list", () => {
  it("has one tip each for Map, Today, project page, Search and Lock", () => {
    expect(TIPS.map((t) => t.name).sort()).toEqual([...NAMES].sort());
  });

  it("keeps every tip short, in every preset, free of banned words and em-dashes", () => {
    const words = ["ho" + "sts?", "snap" + "shots?", "age" + "nts?", "obser" + "ved", "obser" + "vations?", "watch" + "er"];
    const dash = String.fromCharCode(0x2014);
    const banned = new RegExp(`click here|tap here|${dash}|\\b(${words.join("|")})\\b`, "i");
    for (const preset of [{ label: "default", names: DEFAULT_LEVEL_NAMES }, ...LEVEL_PRESETS]) {
      for (const name of NAMES) {
        const line = tipFor(name, facts({ words: wordsOf(preset.names) }));
        expect(line, `${name} for ${preset.label}`).not.toBeNull();
        expect(line!.length).toBeLessThanOrEqual(TIP_MOST);
        expect(line).not.toMatch(banned);
      }
    }
  });

  it("pins the lock tip line and its length", () => {
    const line = tipFor("lock", facts());
    expect(line).toBe("Lock it to keep it for your eyes only.");
    expect(line!.length).toBe(38);
    expect(line!.length).toBeLessThan(TIP_MOST);
    const tip = TIPS.find((t) => t.name === "lock")!;
    expect(tip.deskOnly).toBe(false);
    expect(tip.needs({ smartDates: false })).toBe(true);
  });

  it("follows first run and seen rules for the lock tip", () => {
    expect(tipFor("lock", facts({ state: { ...over, step: 2 } }))).toBeNull();
    expect(tipFor("lock", facts({ state: { ...over, tipsSeen: ["lock"] } }))).toBeNull();
    expect(tipFor("lock", facts({ state: { ...over, tipsSeen: ["map"] } }))).not.toBeNull();
  });

  it("builds the line from the account's words", () => {
    const study = LEVEL_PRESETS.find((p) => p.label === "Study")!;
    expect(tipFor("map", facts({ words: wordsOf(study.names) }))).toContain("assignments");
  });
});

describe("when a tip shows", () => {
  it("shows once first run has ended and the tip is not seen", () => {
    expect(tipFor("map", facts())).not.toBeNull();
  });

  it("shows none while first run is on a step", () => {
    expect(tipFor("map", facts({ state: { ...over, step: 3 } }))).toBeNull();
  });

  it("shows none once its name is seen, and the others still show", () => {
    const state = { ...over, tipsSeen: ["map"] };
    expect(tipFor("map", facts({ state }))).toBeNull();
    expect(tipFor("search", facts({ state }))).not.toBeNull();
  });

  it("shows none when the account has no tips to show (null)", () => {
    expect(tipFor("map", facts({ state: { ...over, tipsSeen: null } }))).toBeNull();
  });

  it("shows none before the answer is known", () => {
    expect(tipFor("map", facts({ state: UNKNOWN }))).toBeNull();
  });

  it("hides a line too long for its words", () => {
    const long = wordsOf({ ...DEFAULT_LEVEL_NAMES, project: "A very long name for the thing" });
    expect(tipFor("project", facts({ words: long }))).toBeNull();
  });
});

describe("phone and Extras", () => {
  const key: Tip = { name: "search", line: () => "Press / to search.", deskOnly: true, needs: () => true };

  it("never shows a desk-only tip on a phone, and does at a desk", () => {
    expect(tipFor("search", facts({ phone: true }), [key])).toBeNull();
    expect(tipFor("search", facts({ phone: false }), [key])).toBe("Press / to search.");
  });

  it("hides the Today tip when Smart dates is off", () => {
    expect(tipFor("today", facts({ smartDates: false }))).toBeNull();
    expect(tipFor("today", facts({ smartDates: true }))).not.toBeNull();
  });
});
