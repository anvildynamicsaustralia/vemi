/**
 * The pure parts of the front page's motion: whether the background field runs, how far a
 * device frame leans toward the pointer, and how a colour read from the page becomes three
 * numbers for the shader. No page is touched here, so each rule is tested without one.
 */

export interface MotionInput {
  /** The person asked for less motion. */
  readonly reducedMotion: boolean;
  /** The browser gave a WebGL context. */
  readonly hasWebGL: boolean;
  /** The tab is showing (not in the background). */
  readonly pageVisible: boolean;
  /** The field's area is on screen. */
  readonly onScreen: boolean;
}

/**
 * "run": draw frames. "pause": keep the context, draw nothing (hidden tab, scrolled away).
 * "still": show the plain gradient and never loop (reduced motion, or no WebGL).
 */
export type MotionPlan = "run" | "pause" | "still";

export function motionPlan(input: MotionInput): MotionPlan {
  if (input.reducedMotion || !input.hasWebGL) return "still";
  if (!input.pageVisible || !input.onScreen) return "pause";
  return "run";
}

/** How far a frame leans, in degrees, at the edge of its box. */
export const MAX_TILT = 3.5;

/**
 * The lean toward a pointer at (x, y) over a box: the box leans so its near edge dips toward
 * the pointer. Zero at the centre, at most `max` degrees at an edge, and zero for an empty box
 * or a pointer far outside it.
 */
export function tiltFor(
  x: number, y: number,
  box: { readonly left: number; readonly top: number; readonly width: number; readonly height: number },
  max: number = MAX_TILT,
): { readonly rx: number; readonly ry: number } {
  if (box.width <= 0 || box.height <= 0) return { rx: 0, ry: 0 };
  const clamp = (n: number): number => Math.max(-1, Math.min(1, n));
  const nx = clamp(((x - box.left) / box.width) * 2 - 1);
  const ny = clamp(((y - box.top) / box.height) * 2 - 1);
  return { rx: round(-ny * max), ry: round(nx * max) };
}

const round = (n: number): number => Math.round(n * 100) / 100 + 0;

/** A colour written as #rgb or #rrggbb, as three numbers from 0 to 1; null for anything else. */
export function parseColour(text: string): readonly [number, number, number] | null {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(text.trim());
  const digits = m?.[1];
  if (digits === undefined) return null;
  const full = digits.length === 3 ? [...digits].map((d) => d + d).join("") : digits;
  const n = (at: number): number => parseInt(full.slice(at, at + 2), 16) / 255;
  return [n(0), n(2), n(4)];
}

/** Whether a colour is dark enough that the page around it is a dark one. */
export const isDarkColour = (c: readonly [number, number, number]): boolean => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2] < 0.5;

/** The frame pace: the field is drawn about this often, not every refresh. */
export const FRAME_MS = 1000 / 30;

/** The pixels the field is drawn at, as a share of the box: a soft field needs few. */
export function fieldScale(devicePixelRatio: number): number {
  const ratio = Number.isFinite(devicePixelRatio) && devicePixelRatio > 0 ? devicePixelRatio : 1;
  return Math.min(ratio, 1.5) * 0.5;
}
