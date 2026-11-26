import type { ReactNode } from "react";
import { Grip } from "./controls.js";
import { useListDrag } from "./useListDrag.js";

/**
 * A list in a manual order, with the one grab point. Decision 8.
 *
 * Every list that used to carry arrow buttons renders through this, so the grip means the
 * same thing in all of them and the drag behaves the same way. The caller says what a row
 * looks like and where the grip sits inside it; this owns the measuring and the moving.
 *
 * A list of one has nothing to reorder, so its grip is inert rather than drawn and dead.
 */
export function OrderedRows<T extends { readonly id: string }>({
  items, label, move, row, className = "item",
}: {
  readonly items: readonly T[];
  /** Names the row for the grip's label, which is what a screen reader reads out. */
  readonly label: (item: T) => string;
  readonly move: (id: string, to: number) => void;
  readonly row: (item: T, grip: ReactNode) => ReactNode;
  readonly className?: string;
}) {
  const many = items.length > 1;
  const drag = useListDrag(items.map((i) => i.id), move, many);
  return (
    <>
      {items.map((item) => {
        const { ref, style, ...held } = drag.row(item.id);
        return (
          <div key={item.id} ref={ref} style={style} {...held}
            className={`${className}${drag.holding === item.id ? " held" : ""}${drag.holding === null ? "" : " while-held"}`}>
            {row(item, many ? <Grip {...drag.grip(item.id, label(item))} /> : null)}
          </div>
        );
      })}
    </>
  );
}
