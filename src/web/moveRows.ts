import type { Kind } from "@vemi/shared";
import { api } from "./api.js";
import type { AppActions } from "./ui/appContext.js";
import { reorder, type Placed } from "./order.js";

/** What a page adds around a move: refuse while one is still settling, and learn when it was sent or refused. */
export interface MoveHooks {
  readonly blocked?: boolean;
  readonly onSent?: () => void;
  readonly onRefused?: () => void;
}

/**
 * Put one record at an index of its list, and remember where it was. The way back is the
 * positions the placement is about to overwrite, read before it is sent. Decision 20.
 */
export const rowMover = (act: AppActions["act"], hooks: MoveHooks = {}) =>
  (kind: Kind, items: readonly Placed[], what: string) => (id: string, to: number): void => {
    const placements = reorder(items, id, to);
    if (placements.length === 0 || hooks.blocked === true) return;
    const back = placements.map((pl) => ({ id: pl.id, position: items.find((i) => i.id === pl.id)?.position ?? pl.position }));
    hooks.onSent?.();
    void act(() => api.place(kind, placements), {
      what: `moved ${what}`,
      undo: () => api.place(kind, back),
      redo: () => api.place(kind, placements),
    }).then((ok) => {
      if (!ok) hooks.onRefused?.();
    });
  };
