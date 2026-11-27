import { useEffect, useRef, useState, type PointerEvent, type ReactNode } from "react";
import { axisOf, followed, releaseOf } from "../swipe.js";
import { haptic } from "../haptics.js";
import { PHONE, useMedia } from "./useMedia.js";
import "./swipeRow.css";

export interface SwipeAction {
  readonly label: string;
  readonly run: () => void;
  /** `done` is the green of finishing, `remove` the accent of archiving; plain is grey. */
  readonly tone?: "done" | "remove" | "plain";
}

/** The one row whose buttons are showing: opening another closes it, as a phone's list does. */
let closeShowing: (() => void) | null = null;

/**
 * A row that swipes, on a phone: right to run its leading action (Done), left to show its
 * trailing buttons (Tomorrow, Archive). Every action here is also on the row's ⋯ or its box,
 * so nothing is reachable only by a gesture, and on a desk the row is drawn as it is.
 */
export function SwipeRow({ lead, trail = [], children, className, off = false }: {
  /** Drawn as it is, with no swipe: a list in a mode of its own (choosing). */
  readonly off?: boolean;
  readonly lead?: SwipeAction;
  readonly trail?: readonly SwipeAction[];
  readonly children: ReactNode;
  readonly className?: string;
}) {
  const phone = useMedia(PHONE);
  const face = useRef<HTMLDivElement>(null);
  const trailBox = useRef<HTMLDivElement>(null);
  const start = useRef<{ x: number; y: number; id: number; axis: "swipe" | "scroll" | null } | null>(null);
  const swiped = useRef(false);
  const [dx, setDx] = useState(0);
  const [open, setOpen] = useState(false);
  const [moving, setMoving] = useState(false);

  const close = (): void => { setOpen(false); setDx(0); };
  useEffect(() => {
    if (!open) return undefined;
    if (closeShowing !== null && closeShowing !== close) closeShowing();
    closeShowing = close;
    // A press anywhere else closes the buttons, as it does in a phone's list.
    const away = (e: Event): void => {
      if (face.current?.parentElement?.contains(e.target as Node) === true) return;
      close();
    };
    document.addEventListener("pointerdown", away, true);
    return () => {
      document.removeEventListener("pointerdown", away, true);
      if (closeShowing === close) closeShowing = null;
    };
  });

  if (!phone || off) return <div className={className}>{children}</div>;

  const trailWidth = (): number => (trail.length === 0 ? 0 : trailBox.current?.offsetWidth ?? 0);
  const width = (): number => face.current?.offsetWidth ?? 320;
  const base = (): number => (open ? -trailWidth() : 0);

  const down = (e: PointerEvent<HTMLDivElement>): void => {
    if (e.pointerType === "mouse") return;
    // A grip drags the row up and down; a press there is never a swipe.
    if ((e.target as Element).closest(".grip") !== null) { start.current = null; return; }
    start.current = { x: e.clientX, y: e.clientY, id: e.pointerId, axis: null };
    swiped.current = false;
  };
  const move = (e: PointerEvent<HTMLDivElement>): void => {
    const s = start.current;
    if (s === null || s.id !== e.pointerId) return;
    const mx = e.clientX - s.x;
    const my = e.clientY - s.y;
    if (s.axis === null) {
      s.axis = axisOf(mx, my);
      if (s.axis === "swipe") {
        swiped.current = true;
        setMoving(true);
        try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* the pointer is gone */ }
      }
    }
    if (s.axis !== "swipe") return;
    const next = followed(base() + mx, lead !== undefined, trailWidth(), width());
    // A buzz as the swipe crosses the point where letting go would finish it, either way.
    const was = releaseOf(dx, width(), lead !== undefined, trailWidth(), open) === "lead";
    const now = releaseOf(next, width(), lead !== undefined, trailWidth(), open) === "lead";
    if (was !== now) haptic("tap");
    setDx(next);
  };
  const up = (e: PointerEvent<HTMLDivElement>): void => {
    const s = start.current;
    start.current = null;
    setMoving(false);
    if (s === null || s.axis !== "swipe") return;
    const total = base() + (e.clientX - s.x);
    const said = releaseOf(total, width(), lead !== undefined, trailWidth(), open);
    if (said === "lead") {
      close();
      lead?.run();
    } else if (said === "open") {
      setOpen(true);
      setDx(-trailWidth());
    } else close();
  };

  const leadShown = lead !== undefined && dx > 0;
  return (
    <div className={`swipe-row${className === undefined ? "" : ` ${className}`}`}>
      {lead !== undefined && (
        <div className={`swipe-lead tone-${lead.tone ?? "done"}${leadShown ? " shown" : ""}`} aria-hidden="true">
          <span>{lead.label}</span>
        </div>
      )}
      {trail.length > 0 && (
        <div className="swipe-trail" ref={trailBox} aria-hidden={!open}>
          {trail.map((a) => (
            <button key={a.label} type="button" tabIndex={open ? 0 : -1} className={`swipe-button tone-${a.tone ?? "plain"}`}
              onClick={() => { close(); a.run(); }}>{a.label}</button>
          ))}
        </div>
      )}
      <div ref={face} className={`swipe-face${moving ? " moving" : ""}`} style={{ transform: dx === 0 ? undefined : `translateX(${dx}px)` }}
        // Down is heard first, before a ⋯ inside the row keeps its press to itself: a swipe that
        // starts on the ⋯ is still a swipe, and its click is the swipe's, not the menu's.
        onPointerDownCapture={down} onPointerMoveCapture={move} onPointerUpCapture={up} onPointerCancel={() => { start.current = null; setMoving(false); close(); }}
        // A swipe ends with a click on whatever was under the finger; that click is the swipe's.
        onClickCapture={(e) => {
          if (swiped.current || open) { e.stopPropagation(); e.preventDefault(); swiped.current = false; if (open) close(); }
        }}>
        {children}
      </div>
    </div>
  );
}
