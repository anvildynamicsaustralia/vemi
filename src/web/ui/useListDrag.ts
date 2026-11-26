import { useCallback, useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { liftBy, shiftFor, targetIndex, type Row } from "../dragTarget.js";

/**
 * One drag for every manual-order list. Decision 8: drag replaces the arrow buttons.
 *
 * Every list that had arrows uses this and nothing else, so the grip means one thing
 * everywhere — drag me up or down this list. The rows are measured once, when the drag
 * begins, and moved only by `transform`, so the flow never changes under the pointer and a
 * list of uneven rows needs no special case.
 *
 * The grip is a real button. Arrow keys move the row without a pointer at all, because
 * deleting the arrow buttons must not delete the only way to reorder from a keyboard.
 */

export interface Held {
  readonly id: string;
  readonly from: number;
  readonly to: number;
  readonly dy: number;
  readonly rows: readonly Row[];
}

export interface ListDrag {
  /** The id being dragged, for a list that wants to dim the rest. */
  readonly holding: string | null;
  /** Spread onto the row's own element. */
  row(id: string): { readonly ref: (el: HTMLElement | null) => void; readonly style: CSSProperties; readonly "data-held"?: true };
  /** Spread onto the grip inside that row. */
  grip(id: string, label: string): {
    readonly onPointerDown: (e: ReactPointerEvent) => void;
    readonly onKeyDown: (e: ReactKeyboardEvent) => void;
    readonly "aria-label": string;
    readonly title: string;
  };
}

export function useListDrag(
  ids: readonly string[],
  move: (id: string, to: number) => void,
  enabled = true,
): ListDrag {
  const els = useRef(new Map<string, HTMLElement>());
  const [held, setHeld] = useState<Held | null>(null);
  const heldRef = useRef<Held | null>(null);
  heldRef.current = held;

  const finish = useCallback((commit: boolean) => {
    const h = heldRef.current;
    setHeld(null);
    if (h !== null && commit && h.to !== h.from) move(h.id, h.to);
  }, [move]);

  // Bound to the window, not the grip: a pointer that leaves the button mid-drag, or a tab
  // that loses focus, must still put the row down rather than leave it stuck in the air.
  useEffect(() => {
    if (held === null) return;
    const onMove = (e: PointerEvent): void => {
      const h = heldRef.current;
      if (h === null) return;
      const dy = e.clientY - h.dy;
      setHeld({ ...h, to: targetIndex(h.rows, h.from, dy) });
      const el = els.current.get(h.id);
      if (el !== undefined) el.style.setProperty("--lift", `${liftBy(h.rows, h.from, dy)}px`);
    };
    const up = (): void => finish(true);
    const onKey = (e: KeyboardEvent): void => { if (e.key === "Escape") finish(false); };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      window.removeEventListener("keydown", onKey);
    };
  }, [held === null, finish]);

  const start = (id: string, clientY: number): void => {
    const from = ids.indexOf(id);
    if (from < 0 || ids.length < 2) return;
    const rows: Row[] = [];
    for (const rowId of ids) {
      const el = els.current.get(rowId);
      if (el === undefined) return;
      const r = el.getBoundingClientRect();
      rows.push({ id: rowId, top: r.top, height: r.height });
    }
    // `dy` holds where the pointer began, and becomes a delta on the first move.
    setHeld({ id, from, to: from, dy: clientY, rows });
  };

  return {
    holding: held?.id ?? null,
    row: (id) => {
      const i = ids.indexOf(id);
      const isHeld = held !== null && held.id === id;
      const shift = held === null ? 0 : shiftFor(held.rows, held.from, held.to, i);
      const style: CSSProperties = isHeld
        ? { transform: "translateY(var(--lift, 0px))", zIndex: 5, position: "relative" }
        : { transform: shift === 0 ? undefined : `translateY(${shift}px)` };
      return {
        ref: (el: HTMLElement | null) => { if (el === null) els.current.delete(id); else els.current.set(id, el); },
        style,
        ...(isHeld ? { "data-held": true as const } : {}),
      };
    },
    grip: (id, label) => ({
      onPointerDown: (e: ReactPointerEvent) => {
        if (!enabled || e.button !== 0) return;
        e.preventDefault();
        start(id, e.clientY);
      },
      onKeyDown: (e: ReactKeyboardEvent) => {
        const at = ids.indexOf(id);
        if (at < 0) return;
        if (e.key === "ArrowUp" && at > 0) { e.preventDefault(); move(id, at - 1); }
        if (e.key === "ArrowDown" && at < ids.length - 1) { e.preventDefault(); move(id, at + 1); }
      },
      "aria-label": `reorder ${label}: hold and drag, or use the arrow keys`,
      title: "drag to reorder, or arrow keys",
    }),
  };
}
