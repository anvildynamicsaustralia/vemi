import { useCallback, useEffect, useMemo, useState } from "react";

/**
 * Choosing several things at once. Decision 9.
 *
 * Selecting is a mode with a switch you can see, not a modifier you have to know: the
 * original failure of this product was not knowing what could be pressed, and decision 13
 * forbids hiding an action behind a gesture. In the mode, a card's body selects instead of
 * opening; out of it, nothing behaves differently from before.
 *
 * It holds ids and nothing else — no order, no records — so it can be called before the
 * surface knows what it is showing. The caller intersects with what is on screen, which
 * also means a selected card that has been archived or filtered away simply stops counting
 * rather than having to be swept up.
 */
export interface Selection {
  readonly on: boolean;
  setOn(on: boolean): void;
  has(id: string): boolean;
  /** Shift extends from the last card touched, along the order given. Never the only way. */
  toggle(id: string, order?: readonly string[], extend?: boolean): void;
  clear(): void;
  /** Exactly these, and nothing else: select all. */
  replace(ids: readonly string[]): void;
  /** Leave the mode and drop the selection: Escape, and a finished action. */
  stop(): void;
}

export function useSelection(): Selection {
  const [on, setOnRaw] = useState(false);
  const [ids, setIds] = useState<ReadonlySet<string>>(new Set());
  const [lastTouched, setLastTouched] = useState<string | null>(null);

  const stop = useCallback(() => {
    setOnRaw(false);
    setIds(new Set());
    setLastTouched(null);
  }, []);

  useEffect(() => {
    if (!on) return;
    const onKey = (e: KeyboardEvent): void => { if (e.key === "Escape") stop(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [on, stop]);

  return useMemo(() => ({
    on,
    setOn: (next: boolean) => { setOnRaw(next); if (!next) { setIds(new Set()); setLastTouched(null); } },
    has: (id: string) => ids.has(id),
    clear: () => { setIds(new Set()); setLastTouched(null); },
    replace: (next) => setIds((current) => (current.size === next.length && next.every((id) => current.has(id)) ? current : new Set(next))),
    stop,
    toggle: (id, order = [], extend = false) => {
      setIds((current) => {
        const next = new Set(current);
        const from = lastTouched === null ? -1 : order.indexOf(lastTouched);
        const to = order.indexOf(id);
        if (extend && from >= 0 && to >= 0) {
          for (const between of order.slice(Math.min(from, to), Math.max(from, to) + 1)) next.add(between);
          return next;
        }
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      });
      setLastTouched(id);
    },
  }), [on, ids, lastTouched, stop]);
}
