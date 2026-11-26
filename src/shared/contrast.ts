/**
 * WCAG 2 contrast maths. Pure: it holds no colour of its own, it only measures the ones
 * it is given, so the palette stays in theme.ts and a test can hold every pair to 4.5:1.
 */

/** The ratio text needs against its ground to read at body size. */
export const MIN_TEXT_CONTRAST = 4.5;

const HEX = /^#[0-9a-fA-F]{6}$/;

function channel(value: number): number {
  const c = value / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** Relative luminance of a `#rrggbb` colour, 0 (black) to 1 (white). Throws on bad input. */
export function luminance(hex: string): number {
  if (!HEX.test(hex)) throw new Error(`not a #rrggbb colour: ${hex}`);
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** Contrast ratio of two `#rrggbb` colours, 1 to 21, in either order. */
export function contrast(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}
