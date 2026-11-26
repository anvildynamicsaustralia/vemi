import { describe, expect, it } from "vitest";
import { ACCENTS, COLOUR_TOKENS, parseTheme, THEME, THEMES, withAccent } from "./theme.js";
import { MIN_TEXT_CONTRAST, contrast } from "./contrast.js";

describe("parseTheme", () => {
  it("gives the shipped table for anything that is not an object", () => {
    expect(parseTheme(null)).toEqual(THEME);
    expect(parseTheme("nope")).toEqual(THEME);
    expect(parseTheme(42)).toEqual(THEME);
  });

  it("takes a six-digit hex and lowercases it", () => {
    expect(parseTheme({ ink: "#FF0000" }).ink).toBe("#ff0000");
  });

  it("refuses anything that is not a six-digit hex", () => {
    expect(parseTheme({ ink: "#f00" }).ink).toBe(THEME.ink);
    expect(parseTheme({ live: "red" }).live).toBe(THEME.live);
  });

  it("ignores a key it does not know", () => {
    const t = parseTheme({ nonsense: "x", ink: "#010203" }) as unknown as Record<string, unknown>;
    expect(t["nonsense"]).toBeUndefined();
    expect(t["ink"]).toBe("#010203");
  });

  it("takes a hyphenated token, which is the key and the property at once", () => {
    expect(parseTheme({ "live-pressed": "#ABCDEF" })["live-pressed"]).toBe("#abcdef");
    expect(parseTheme({ "hair-light": "#ABCDEF" })["hair-light"]).toBe("#abcdef");
  });

  it("carries every token in the list, in both tables, so a new one cannot be missed", () => {
    for (const table of Object.values(THEMES)) {
      for (const key of COLOUR_TOKENS) expect(table[key]).toMatch(/^#[0-9a-f]{6}$/);
      expect(Object.keys(table).sort()).toEqual([...COLOUR_TOKENS].sort());
    }
  });

  it("is light by default: THEME is the light table, on a white page", () => {
    expect(THEME).toBe(THEMES.light);
    expect(THEME.page).toBe("#ffffff");
    expect(Object.values(THEME)).not.toContain("#0b0a09");
  });
});

describe("the two tables", () => {
  it("keep the token names legacy used", () => {
    for (const key of ["ink", "white", "live", "live-pressed", "live-tint", "live-wash", "mid", "dim", "hair", "hair-light", "edge", "field", "canvas", "frame", "hairline", "link", "faint", "tile", "bar-rule", "bar-ink"]) {
      expect(COLOUR_TOKENS).toContain(key);
    }
  });

  it("carry the 14 Nov values for the tokens the mocks give", () => {
    expect(THEMES.light).toMatchObject({ ink: "#0b0b0b", mid: "#6b6660", dim: "#76706a", hair: "#e4e1dc", "live-hover": "#a83a0f", "live-tint": "#fef6f2" });
    expect(THEMES.dark).toMatchObject({ page: "#121110", white: "#1c1b19", ink: "#f2efea", dim: "#9c958b", "live-text": "#f2915f", "live-tint": "#2a1b13" });
  });

  for (const [name, table] of Object.entries(THEMES)) {
    for (const text of ["ink", "mid", "dim", "link", "faint", "live-text"] as const) {
      for (const ground of ["page", "white", "canvas", "field", "live-tint"] as const) {
        it(`${name}: ${text} on ${ground} is at least ${MIN_TEXT_CONTRAST}:1`, () => {
          expect(contrast(table[text], table[ground])).toBeGreaterThanOrEqual(MIN_TEXT_CONTRAST);
        });
      }
    }
    for (const ground of ["page", "white", "canvas", "field", "live-tint"] as const) {
      it(`${name}: a control's border (line) on ${ground} is at least 3:1`, () => {
        expect(contrast(table.line, table[ground])).toBeGreaterThanOrEqual(3);
      });
    }
    it(`${name}: text on an accent fill reads`, () => {
      expect(contrast(table["on-live"], table["live-pressed"])).toBeGreaterThanOrEqual(MIN_TEXT_CONTRAST);
      expect(contrast(table["on-live"], table["live-hover"])).toBeGreaterThanOrEqual(MIN_TEXT_CONTRAST);
    });
  }
});

describe("accents", () => {
  it("names six, ember first", () => {
    expect(Object.keys(ACCENTS)).toEqual(["ember", "ocean", "moss", "violet", "rose", "graphite"]);
  });

  it("ember is the table as shipped", () => {
    expect(withAccent(THEMES.light, "ember", "light")).toEqual(THEMES.light);
    expect(withAccent(THEMES.dark, "ember", "dark")).toEqual(THEMES.dark);
  });

  for (const name of Object.keys(ACCENTS) as Array<keyof typeof ACCENTS>) {
    it(`${name}: reads in both themes`, () => {
      for (const mode of ["light", "dark"] as const) {
        const t = withAccent(THEMES[mode], name, mode);
        expect(contrast(t["live-text"], t.white)).toBeGreaterThanOrEqual(MIN_TEXT_CONTRAST);
        expect(contrast(t["on-live"], t["live-pressed"])).toBeGreaterThanOrEqual(MIN_TEXT_CONTRAST);
      }
    });
  }
});
