import { useEffect, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { roveTo } from "../rove.js";
import { HOLD_EVENT } from "./holdMenu.js";
import { Panel } from "./Picker.js";

/** One line of a ⋯ menu: something to do, or — with no `run` — something it says. */
export interface MenuItem {
  readonly label: string;
  readonly run?: () => void;
  /** Destroys or removes: drawn in the accent so it is never mistaken for the rest. */
  readonly tone?: "remove";
  readonly disabled?: boolean;
}

/**
 * The ⋯ in the corner of a page or a card (VEMI-007): what can be done to the thing it sits
 * on, and on a phone what a phone hides. It hangs from its button the way every picker does —
 * under it on a desk, up from the bottom edge on a phone — and it never starts a drag or
 * opens the card it sits on: the press is spent on the ⋯.
 *
 * Touch and hold on the card it sits on opens it too, and so does a secondary click
 * (`holdMenu.ts`, VEMI-008).
 *
 * From the keyboard it opens onto the first line that can be used. The arrow keys, Home and End
 * move through its lines; Escape and Tab close it and put the focus back on the ⋯. Some
 * things are only ever done from a ⋯, so a menu a keyboard cannot get into keeps them from it.
 */
export function MoreMenu({ items, label, className }: {
  readonly items: readonly MenuItem[];
  /** What the menu is for, read out: "project Dingo Engine". */
  readonly label: string;
  readonly className?: string;
}) {
  const [tiedTo, tieTo] = useState<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (tiedTo === null) return;
    const held = (): void => setOpen(true);
    tiedTo.addEventListener(HOLD_EVENT, held);
    return () => tiedTo.removeEventListener(HOLD_EVENT, held);
  }, [tiedTo]);
  if (items.length === 0) return null;
  const stop = (e: { stopPropagation: () => void }): void => e.stopPropagation();
  // The keyboard lands on the first line it can use, and moves by the arrow keys from there.
  const first = items.find((item) => item.run !== undefined && item.disabled !== true);
  const rove = (e: ReactKeyboardEvent<HTMLDivElement>): void => {
    const lines = [...e.currentTarget.querySelectorAll<HTMLElement>("[role='menuitem']:not(:disabled)")];
    const at = roveTo(e, document.activeElement instanceof HTMLElement ? lines.indexOf(document.activeElement) : -1, lines.length);
    if (at === null) return;
    e.preventDefault();
    lines[at]?.focus();
  };
  return (
    <>
      <button ref={tieTo} type="button" className={`more-button${open ? " open" : ""}${className === undefined ? "" : ` ${className}`}`}
        data-more aria-haspopup="menu" aria-expanded={open} aria-label={`more for ${label}`} title="more"
        onPointerDown={stop} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") e.stopPropagation(); }}
        onClick={(e) => { stop(e); setOpen(!open); }}>
        <span aria-hidden="true">⋯</span>
      </button>
      {open && tiedTo !== null && (
        <Panel tiedTo={tiedTo} returnTo={tiedTo} onClose={() => setOpen(false)} label={`more for ${label}`} width={240}>
          <div className="menu-list" role="menu" aria-label={`more for ${label}`} onPointerDown={stop} onKeyDown={rove}>
            {items.map((item) => item.run === undefined ? (
              <div key={item.label} className="menu-note" role="note">{item.label}</div>
            ) : (
              // Out of the Tab order, as a menu's lines are: Tab leaves the menu (`Panel`).
              <button key={item.label} type="button" role="menuitem" disabled={item.disabled} tabIndex={-1}
                data-autofocus={item === first ? "" : undefined}
                className={`picker-item menu-item${item.tone === "remove" ? " remove" : ""}`}
                onClick={(e) => {
                  stop(e);
                  setOpen(false);
                  // Back on the ⋯ before the line runs, so a sheet it opens returns the
                  // focus there when it closes.
                  tiedTo.focus({ preventScroll: true });
                  item.run?.();
                }}>
                {item.label}
              </button>
            ))}
          </div>
        </Panel>
      )}
    </>
  );
}
