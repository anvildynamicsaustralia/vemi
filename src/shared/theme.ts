/**
 * Runtime-editable design tokens. Colour carries state and nothing else.
 *
 * VEMI-013 (design) brings the 14 Nov look as two tables, `light` and `dark`, and one
 * switch between them: the `data-theme` attribute on the root, written by the web app.
 * Token names are the ones the app already used. The mocks' names map as card = white,
 * soft hairline = hair-light, press = live-pressed, tint = live-tint. New here: `page`
 * (the ground behind a card, which only differs from white in the dark table),
 * `live-hover`, `live-text` and `on-live`. The accent is one of six (`ACCENTS`) laid over
 * a table with `withAccent`.
 *
 * VEMI-006 replaced the warm near-black table VEMI-002 decision 36 shipped, and removed the
 * `on-map` override set that forced the map black (VEMI-002 decision 16). That stays gone:
 * the map is the page's ground in either theme.
 *
 * Where the 14 Nov mocks give a value, it is used as given. The rest (live-wash, frame,
 * hairline, tile and the selection bar in the dark table) are derived by the same steps
 * the mocks take between their light and dark values. `link` and `faint` are text on a
 * ground, so they pass 4.5:1 and equal `dim`; a label that quiet is no longer readable.
 *
 * Decision 9's rule is untouched: colour carries state and never decoration, and every
 * token is editable at runtime, so nothing may assume a fixed value.
 */

export interface Theme {
  /** Text, plate borders, the blocked tag, dark fills. */
  readonly ink: string;
  /** The ground behind everything: the body. */
  readonly page: string;
  /** The plate, card and sheet ground. */
  readonly white: string;
  /**
   * The accent, and the only hue in the interface.
   *
   * Every interactive thing wears it: rings, the active rail dot, a selected chip, a link,
   * a primary button, a drop target's edge. One accent is why a thing that does nothing can
   * never look like a thing that does.
   */
  readonly live: string;
  /** Pressed, and the resting colour of an accent fill that carries text. */
  readonly "live-pressed": string;
  /** An accent fill while the pointer is over it, one step past pressed. */
  readonly "live-hover": string;
  /** The accent as a word on a ground: a link, a selected tab. Passes 4.5:1 on every ground. */
  readonly "live-text": string;
  /** Text on an accent fill. */
  readonly "on-live": string;
  /** A selected chip's fill. */
  readonly "live-tint": string;
  /**
   * A drop target's fill, a shade lighter than the chip's.
   *
   * Its own token rather than the same one: a chip you chose and a column you are about to
   * drop into are not the same news, and the two sit side by side on the board.
   */
  readonly "live-wash": string;
  /** Secondary copy. */
  readonly mid: string;
  /** Labels, kickers, captions. */
  readonly dim: string;
  /** Ordinary borders, and a dot matrix's empty cells. */
  readonly hair: string;
  /** Row borders and ring tracks, which must be quieter than an ordinary border. */
  readonly "hair-light": string;
  /** Quiet borders, the grip, an inactive dot, a day already past. */
  readonly edge: string;
  /**
   * The border of a control a person has to find: a field, a chip, a button. At least 3:1
   * against every ground it sits on, so the edge of the thing is seen without hovering it.
   */
  readonly line: string;
  /** A tinted block, and an owned plate. */
  readonly field: string;
  /** The Space canvas and a board column. */
  readonly canvas: string;
  /** A dashed venture frame on the Space canvas. */
  readonly frame: string;
  /** A hairline divider, quieter again than a row border. */
  readonly hairline: string;
  /** A link between two ventures: the dotted rule and its caption. Never ownership's ink. */
  readonly link: string;
  /** A frame's name when it is not the venture you are in, and a button that cannot act yet. */
  readonly faint: string;
  /** A phone's venture tile when it is not the one open. */
  readonly tile: string;
  /** The rule between the count and the actions on the selection bar. */
  readonly "bar-rule": string;
  /** An action's word on the selection bar: white would shout, and it is not the count. */
  readonly "bar-ink": string;
}

const LIGHT: Theme = {
  ink: "#0b0b0b",
  page: "#ffffff",
  white: "#ffffff",
  live: "#e85c24",
  "live-pressed": "#c24614",
  "live-hover": "#a83a0f",
  "live-text": "#c24614",
  "on-live": "#ffffff",
  "live-tint": "#fef6f2",
  "live-wash": "#fef9f6",
  mid: "#6b6660",
  dim: "#76706a",
  hair: "#e4e1dc",
  "hair-light": "#edeae5",
  edge: "#cfc9c0",
  line: "#8a857e",
  field: "#faf9f7",
  canvas: "#fcfbf9",
  frame: "#dcd7cf",
  hairline: "#f0ede8",
  link: "#76706a",
  faint: "#76706a",
  tile: "#f6f4f0",
  "bar-rule": "#3a3733",
  "bar-ink": "#e8e4de",
};

const DARK: Theme = {
  ink: "#f2efea",
  page: "#121110",
  white: "#1c1b19",
  live: "#e85c24",
  "live-pressed": "#c24614",
  "live-hover": "#a83a0f",
  "live-text": "#f2915f",
  "on-live": "#ffffff",
  "live-tint": "#2a1b13",
  "live-wash": "#211812",
  mid: "#b8b1a7",
  dim: "#9c958b",
  hair: "#2e2b27",
  "hair-light": "#26241f",
  edge: "#45403a",
  line: "#726d66",
  field: "#22201e",
  canvas: "#151413",
  frame: "#3a3630",
  hairline: "#201e1b",
  link: "#9c958b",
  faint: "#9c958b",
  tile: "#1f1d1b",
  "bar-rule": "#cfc9c0",
  "bar-ink": "#3a3733",
};

export type ThemeName = "light" | "dark";

/** The two tables, and the only two. One attribute on the root picks between them. */
export const THEMES: Readonly<Record<ThemeName, Theme>> = { light: LIGHT, dark: DARK };

/** The light table: the default, and what a value missing from input falls back to. */
export const THEME: Theme = LIGHT;

/** An accent: what it replaces in a table. `onDark` is the live text on the dark theme. */
export interface Accent {
  readonly live: string;
  readonly press: string;
  readonly hover: string;
  readonly onDark: string;
}

export const ACCENTS = {
  ember: { live: "#e85c24", press: "#c24614", hover: "#a83a0f", onDark: "#f2915f" },
  ocean: { live: "#2f7fd8", press: "#1f63b3", hover: "#174f91", onDark: "#7db3f0" },
  moss: { live: "#3e9b5b", press: "#2d7a45", hover: "#226035", onDark: "#7fcb95" },
  violet: { live: "#7a5ce0", press: "#5e42c4", hover: "#4a33a0", onDark: "#b09cf2" },
  rose: { live: "#d9487a", press: "#b8325f", hover: "#962649", onDark: "#f08fb0" },
  graphite: { live: "#6b6660", press: "#4a4641", hover: "#36332f", onDark: "#b8b1a7" },
} as const satisfies Record<string, Accent>;

export type AccentName = keyof typeof ACCENTS;

/** A table with an accent laid over it. Live text is the press colour on light, onDark on dark. */
export function withAccent(table: Theme, name: AccentName, mode: ThemeName): Theme {
  const a = ACCENTS[name];
  return {
    ...table,
    live: a.live,
    "live-pressed": a.press,
    "live-hover": a.hover,
    "live-text": mode === "dark" ? a.onDark : a.press,
  };
}

/** Which table the account wants: one of the two, or whichever the device is set to. */
export const THEME_MODES = ["light", "dark", "system"] as const;
export type ThemeMode = (typeof THEME_MODES)[number];

/** How much room a row takes. Compact trims the paddings, never the type. */
export const SPACINGS = ["comfortable", "compact"] as const;
export type Spacing = (typeof SPACINGS)[number];

/** How the map home is drawn: plates in a grid, or boxes on a canvas. */
export const MAP_STYLES = ["grid", "canvas"] as const;
export type MapStyle = (typeof MAP_STYLES)[number];

/** The four look settings an account keeps. Ember, comfortable, match the device, grid. */
export interface Appearance {
  readonly accent: AccentName;
  readonly spacing: Spacing;
  readonly theme: ThemeMode;
  readonly mapStyle: MapStyle;
}

export const DEFAULT_APPEARANCE: Appearance = { accent: "ember", spacing: "comfortable", theme: "system", mapStyle: "grid" };

export const isAccent = (v: unknown): v is AccentName => typeof v === "string" && Object.hasOwn(ACCENTS, v);
export const isSpacing = (v: unknown): v is Spacing => SPACINGS.some((s) => s === v);
export const isThemeMode = (v: unknown): v is ThemeMode => THEME_MODES.some((m) => m === v);
export const isMapStyle = (v: unknown): v is MapStyle => MAP_STYLES.some((m) => m === v);

export const COLOUR_TOKENS = [
  "ink", "page", "white", "live", "live-pressed", "live-hover", "live-text", "on-live",
  "live-tint", "live-wash",
  "mid", "dim", "hair", "hair-light", "edge", "line", "field", "canvas", "frame", "hairline",
  "link", "faint", "tile", "bar-rule", "bar-ink",
] as const;

const HEX = /^#[0-9a-fA-F]{6}$/;

/** Merge unknown input over the shipped light table. Never throws. Unknown keys are ignored. */
export function parseTheme(input: unknown): Theme {
  if (typeof input !== "object" || input === null) return THEME;
  const src = input as Record<string, unknown>;
  const out: Record<string, string> = { ...THEME };

  for (const key of COLOUR_TOKENS) {
    const v = src[key];
    if (typeof v === "string" && HEX.test(v)) out[key] = v.toLowerCase();
  }

  return out as unknown as Theme;
}
