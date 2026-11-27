import { useEffect, useRef, useState } from "react";
import { haptic } from "../haptics.js";
import { pulled, ready } from "../pull.js";
import { refetchShown } from "../state/resources.js";
import "./pullToRefresh.css";

/** Where a pull is never a pull: a sheet is open, or the finger is on something that scrolls or drags itself. */
const NOT_HERE = ".backdrop, .canvas-wrap, .selection-bar, .grip, input, textarea, [contenteditable='true']";

/**
 * On a phone, pull down from the top of the page to read everything on screen again, as a
 * phone's own lists do. It listens and never holds the page: the scroll is the browser's, and
 * the page's own pull-to-reload is turned off in CSS so the two never both happen.
 */
export function PullToRefresh() {
  const [dy, setDy] = useState(0);
  const [busy, setBusy] = useState(false);
  const from = useRef<number | null>(null);
  const crossed = useRef(false);

  useEffect(() => {
    const start = (e: TouchEvent): void => {
      const target = e.target as Element | null;
      if (window.scrollY > 0 || e.touches.length !== 1 || target?.closest(NOT_HERE) != null) { from.current = null; return; }
      from.current = e.touches[0]?.clientY ?? null;
      crossed.current = false;
    };
    const move = (e: TouchEvent): void => {
      if (from.current === null) return;
      const d = (e.touches[0]?.clientY ?? from.current) - from.current;
      if (d <= 0 || window.scrollY > 0) { setDy(0); return; }
      const now = ready(d);
      if (now !== crossed.current) { crossed.current = now; if (now) haptic("tap"); }
      setDy(d);
    };
    const end = (): void => {
      if (from.current === null) return;
      from.current = null;
      if (crossed.current) {
        setBusy(true);
        refetchShown();
        window.setTimeout(() => setBusy(false), 700);
      }
      crossed.current = false;
      setDy(0);
    };
    window.addEventListener("touchstart", start, { passive: true });
    window.addEventListener("touchmove", move, { passive: true });
    window.addEventListener("touchend", end, { passive: true });
    window.addEventListener("touchcancel", end, { passive: true });
    return () => {
      window.removeEventListener("touchstart", start);
      window.removeEventListener("touchmove", move);
      window.removeEventListener("touchend", end);
      window.removeEventListener("touchcancel", end);
    };
  }, []);

  const at = busy ? 56 : pulled(dy);
  if (at === 0 && !busy) return null;
  return (
    <div className={`pull${busy ? " busy" : ""}${ready(dy) ? " ready" : ""}`} style={{ transform: `translate(-50%, ${at - 44}px)` }}
      role="status" aria-live="polite">
      <span className="pull-ring" aria-hidden="true" style={{ transform: `rotate(${Math.round(at * 4)}deg)` }} />
      <span className="sr-only">{busy ? "Refreshing" : ready(dy) ? "Let go to refresh" : "Pull to refresh"}</span>
    </div>
  );
}
