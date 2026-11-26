import { useRef, type ReactNode } from "react";
import { tabTo } from "../rove.js";

/** One tab: its key, and what it draws inside its button. */
export interface TabSpec {
  readonly id: string;
  readonly className: string;
  readonly content: ReactNode;
}

/**
 * A row of tabs that behave as one stop for the keyboard: Tab lands on the selected one,
 * the arrow keys, Home and End move the selection (and the focus) along the row, and each
 * tab names the panel it opens. The page draws the panel with `id={panelId}` and
 * `aria-labelledby={tabId(row, selected)}`.
 */
export function TabRow({ row, label, tabs, selected, onPick }: {
  readonly row: string;
  readonly label: string;
  readonly tabs: readonly TabSpec[];
  readonly selected: string;
  readonly onPick: (id: string) => void;
}) {
  const tabsEl = useRef<HTMLDivElement>(null);
  return (
    <div ref={tabsEl} className="pm-cards" role="tablist" aria-label={label}
      onKeyDown={(e) => {
        const at = tabs.findIndex((t) => t.id === selected);
        const to = tabTo(e, at, tabs.length);
        const next = to === null ? undefined : tabs[to];
        if (next === undefined) return;
        e.preventDefault();
        onPick(next.id);
        tabsEl.current?.querySelectorAll<HTMLElement>('[role="tab"]')[to ?? 0]?.focus();
      }}>
      {tabs.map((t) => (
        <button key={t.id} id={tabId(row, t.id)} type="button" role="tab" aria-selected={t.id === selected}
          aria-controls={panelId(row)} tabIndex={t.id === selected ? 0 : -1}
          className={`${t.className}${t.id === selected ? " on" : ""}`} onClick={() => onPick(t.id)}>
          {t.content}
        </button>
      ))}
    </div>
  );
}

export const tabId = (row: string, id: string): string => `${row}-tab-${id === "" ? "none" : id}`;
export const panelId = (row: string): string => `${row}-panel`;
