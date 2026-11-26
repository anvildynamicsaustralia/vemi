/**
 * Where each box sits on the canvas, and the lines between them. Pure.
 *
 * The auto layout is the one the mock draws: top-level spaces in columns, left to right;
 * each space's projects stacked under it; a nested space under its parent's projects, with
 * its own projects stacked beneath it. A box the person has moved is where they put it
 * (`resolve`), and Tidy throws their positions away and asks for this layout again.
 */
import type { CanvasPosition } from "@vemi/shared";
import type { Plate } from "../plates.js";

export type BoxKind = CanvasPosition["kind"];

export interface Point {
  readonly x: number;
  readonly y: number;
}

/** A box on the canvas. `key` is unique across both kinds. */
export interface Box extends Point {
  readonly key: string;
  readonly kind: BoxKind;
  readonly id: string;
  /** The space or project this one hangs from, or null for a top-level space. */
  readonly parent: string | null;
  /** The space a project belongs to, or the space itself. */
  readonly ventureId: string;
}

export const SIZE = {
  venture: { w: 230, h: 58 },
  project: { w: 190, h: 38 },
} as const;

const MARGIN = 40;
const INDENT = 40;
const GAP_UNDER = 22;
const GAP_ROW = 10;
const GAP_COLUMN = 60;
/** The wire leaves a parent this far in from its left edge. */
const WIRE_INSET = 24;

export const boxKey = (kind: BoxKind, id: string): string => `${kind}:${id}`;

/** The tree of plates as boxes, parents before children, in the order they are drawn. */
export function autoLayout(plates: readonly Plate[]): Box[] {
  const out: Box[] = [];
  let left = MARGIN;

  /** Places one space and everything under it. Returns the y below it and the furthest right it reached. */
  const place = (plate: Plate, x: number, y: number, parent: string | null): { readonly bottom: number; readonly right: number } => {
    const key = boxKey("venture", plate.id);
    out.push({ key, kind: "venture", id: plate.id, parent, ventureId: plate.id, x, y });
    let at = y + SIZE.venture.h + GAP_UNDER;
    let right = x + SIZE.venture.w;
    for (const p of plate.projects) {
      out.push({ key: boxKey("project", p.id), kind: "project", id: p.id, parent: key, ventureId: plate.id, x: x + INDENT, y: at });
      at += SIZE.project.h + GAP_ROW;
      right = Math.max(right, x + INDENT + SIZE.project.w);
    }
    for (const inner of plate.inner) {
      const below = place(inner, x + INDENT, at + GAP_ROW, key);
      at = below.bottom;
      right = Math.max(right, below.right);
    }
    return { bottom: at, right };
  };

  for (const plate of plates) {
    const done = place(plate, left, MARGIN, null);
    left = done.right + GAP_COLUMN;
  }
  return out;
}

/**
 * The auto layout with the person's saved positions laid over it. A saved position for a box
 * that is gone is ignored; a box with none stays where the layout puts it. Never negative.
 */
export function resolve(plates: readonly Plate[], saved: readonly CanvasPosition[]): Box[] {
  const mine = new Map(saved.map((s) => [boxKey(s.kind, s.id), s]));
  return autoLayout(plates).map((b) => {
    const s = mine.get(b.key);
    return s === undefined ? b : { ...b, x: Math.max(0, s.x), y: Math.max(0, s.y) };
  });
}

/** A box as the API stores it. */
export const positionOf = (b: Box): CanvasPosition => ({ kind: b.kind, id: b.id, x: Math.round(b.x), y: Math.round(b.y) });

export interface Wire {
  readonly key: string;
  readonly d: string;
}

/** One dashed connector from each box to the box it hangs from. */
export function wires(boxes: readonly Box[]): Wire[] {
  const at = new Map(boxes.map((b) => [b.key, b]));
  const out: Wire[] = [];
  for (const b of boxes) {
    const from = b.parent === null ? undefined : at.get(b.parent);
    if (from === undefined) continue;
    const x1 = from.x + WIRE_INSET;
    const y1 = from.y + SIZE[from.kind].h;
    const x2 = b.x;
    const y2 = b.y + SIZE[b.kind].h / 2;
    out.push({ key: b.key, d: `M${x1} ${y1} C ${x1} ${y2}, ${x1} ${y2}, ${x2} ${y2}` });
  }
  return out;
}

/** The size the ground needs to hold every box, with room to drag further. */
export function groundSize(boxes: readonly Box[]): { readonly w: number; readonly h: number } {
  let w = 1320;
  let h = 720;
  for (const b of boxes) {
    w = Math.max(w, b.x + SIZE[b.kind].w + MARGIN * 2);
    h = Math.max(h, b.y + SIZE[b.kind].h + MARGIN * 2);
  }
  return { w, h };
}

export const ZOOM_MIN = 0.5;
export const ZOOM_MAX = 1.5;
export const ZOOM_RESET = 1;

/** One 10% step, in or out, kept between 50% and 150% and free of float drift. */
export function stepZoom(zoom: number, direction: 1 | -1): number {
  const next = Math.round(zoom * 10) + direction;
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, next / 10));
}

/** Pointer travel, in screen pixels, under which a press is a click. */
export const DRAG_SLOP = 4;

/** Whether a press that travelled (dx, dy) was a click or a drag. */
export function gesture(dx: number, dy: number): "click" | "drag" {
  return Math.hypot(dx, dy) < DRAG_SLOP ? "click" : "drag";
}

/** Where a box lands after a drag: the pointer's travel in ground units, never off the top or left. */
export function dragged(from: Point, dx: number, dy: number, zoom: number): Point {
  return { x: Math.max(0, from.x + dx / zoom), y: Math.max(0, from.y + dy / zoom) };
}
