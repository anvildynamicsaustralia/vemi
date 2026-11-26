import { describe, expect, it } from "vitest";
import { MIN_TEXT_CONTRAST, contrast, luminance } from "./contrast.js";

/** The 14 Nov mock values, as recorded in the design phase plan (The tokens). */
const LIGHT = {
  background: "#ffffff", canvas: "#fcfbf9", card: "#ffffff", field: "#faf9f7", tint: "#fef6f2",
  ink: "#0b0b0b", mid: "#6b6660", dim: "#76706a", liveText: "#c24614",
};
const DARK = {
  background: "#121110", canvas: "#151413", card: "#1c1b19", field: "#22201e", tint: "#2a1b13",
  ink: "#f2efea", mid: "#b8b1a7", dim: "#9c958b", liveText: "#f2915f",
};

/** name, press, press hover, live text on dark */
const ACCENTS: ReadonlyArray<readonly [string, string, string, string]> = [
  ["Ember", "#c24614", "#a83a0f", "#f2915f"],
  ["Ocean", "#1f63b3", "#174f91", "#7db3f0"],
  ["Moss", "#2d7a45", "#226035", "#7fcb95"],
  ["Violet", "#5e42c4", "#4a33a0", "#b09cf2"],
  ["Rose", "#b8325f", "#962649", "#f08fb0"],
  ["Graphite", "#4a4641", "#36332f", "#b8b1a7"],
];

const GROUNDS = ["background", "canvas", "card", "field", "tint"] as const;
const TEXTS = ["ink", "mid", "dim", "liveText"] as const;

describe("contrast maths", () => {
  it("matches the known extremes", () => {
    expect(luminance("#ffffff")).toBeCloseTo(1, 5);
    expect(luminance("#000000")).toBeCloseTo(0, 5);
    expect(contrast("#000000", "#ffffff")).toBeCloseTo(21, 3);
    expect(contrast("#ffffff", "#000000")).toBeCloseTo(21, 3);
  });
  it("rejects a value that is not #rrggbb", () => {
    expect(() => luminance("red")).toThrow();
  });
});

describe("text on its grounds", () => {
  for (const [theme, table] of [["light", LIGHT], ["dark", DARK]] as const) {
    for (const text of TEXTS) {
      for (const ground of GROUNDS) {
        it(`${theme}: ${text} on ${ground} is at least ${MIN_TEXT_CONTRAST}:1`, () => {
          expect(contrast(table[text], table[ground])).toBeGreaterThanOrEqual(MIN_TEXT_CONTRAST);
        });
      }
    }
  }
});

describe("accents", () => {
  for (const [name, press, hover, onDark] of ACCENTS) {
    it(`${name}: white on press and on press hover`, () => {
      expect(contrast("#ffffff", press)).toBeGreaterThanOrEqual(MIN_TEXT_CONTRAST);
      expect(contrast("#ffffff", hover)).toBeGreaterThanOrEqual(MIN_TEXT_CONTRAST);
    });
    it(`${name}: live text on the dark card`, () => {
      expect(contrast(onDark, DARK.card)).toBeGreaterThanOrEqual(MIN_TEXT_CONTRAST);
    });
  }
});
