import { useEffect, useRef, type ReactNode } from "react";
import { trapTab, useBackCloses, useFocusReturn } from "./controls.js";

/**
 * The one sheet: a modal layer every picker, dialog and list in the interface is built on.
 * A click on the backdrop closes it; a click inside does not, and neither does a drag that
 * started inside and let go outside, which is how text gets selected. Back closes it too.
 *
 * The focus goes into it as it opens. A field or a row inside that asks for the focus has
 * it already (a child's autofocus lands before this runs) and otherwise the sheet itself
 * takes it, so Tab, shift-Tab and Escape work in it from the first key. A sheet opened from
 * a menu line that has just gone had nothing holding the focus but the page behind.
 *
 * Its parts are the classes `sheet-head`, `sheet-body`, `sheet-section`, `sheet-actions` and
 * `sheet-foot`; a screen lays its own content inside them and never draws a second sheet.
 */
export function Sheet({ onClose, children, className, placement = "top", label }: {
  readonly onClose: () => void;
  readonly children: ReactNode;
  readonly className?: string;
  readonly placement?: "top" | "centre";
  readonly label?: string;
}) {
  useFocusReturn();
  useBackCloses(onClose);
  const pressedOutside = useRef(false);
  const sheet = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = sheet.current;
    if (el !== null && !el.contains(document.activeElement)) el.focus({ preventScroll: true });
  }, []);
  return (
    <div className={`backdrop backdrop-${placement}`}
      onPointerDown={(e) => { pressedOutside.current = e.target === e.currentTarget; }}
      onClick={(e) => {
        if (e.target === e.currentTarget && pressedOutside.current) onClose();
        pressedOutside.current = false;
      }}>
      <div ref={sheet} tabIndex={-1} className={`sheet ${className ?? ""}`} role="dialog" aria-modal="true" aria-label={label}
        onKeyDown={(e) => {
          trapTab(e);
          // Escape closes whatever is built on this, rather than only the sheets App.tsx
          // happens to know the state of. A dialog you cannot leave by keyboard is a trap,
          // and the delete sheet was one. Harmless where the global handler also acts: both
          // close the same thing.
          if (e.key !== "Escape" || e.defaultPrevented) return;
          e.stopPropagation();
          onClose();
        }}>
        {children}
      </div>
    </div>
  );
}
