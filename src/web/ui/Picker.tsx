import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Icon } from "@vemi/icons";
import { fullDate, shortDate } from "../format.js";
import { addDays, dayStep, localToday, monthGrid, monthOf, monthTitle, shiftMonth, WEEKDAYS, type Month } from "../monthGrid.js";
import { Chip } from "./Chip.js";
import { tabbables, useBackCloses } from "./controls.js";
import { PHONE, useMedia } from "./useMedia.js";

/**
 * Choosing one thing from a set, and choosing a day. Never a native control.
 *
 * `PROMPT.md`: "When a set is too big for buttons it becomes a searchable visual picker or a
 * drill-in, never a native dropdown." Decision 14: "Dates are set by tapping a small
 * calendar." decisions.md lists the native dropdown and the native date input as a fault of
 * the build the rework replaced, and eight of one and four of the other were still in it.
 *
 * What was wrong with them is what was wrong with everything this effort fixed: a select
 * styled to match the page has no arrow, so it reads as a label and nothing says it can be
 * pressed; and a native date input is drawn by the browser, so on a phone it is a wheel
 * that takes three scrolls to say "next week".
 *
 * Both open a panel under the button that opened them, on a desk, and a sheet along the
 * bottom of the screen on a phone, where a thumb can reach every row of it.
 */

export interface PickOption {
  readonly id: string;
  readonly name: string;
  /** A quieter second reading: "3 left", "owned by Acme". */
  readonly sub?: string;
  /** Drawn inset, under the option above it. Decision 21: ownership is drawn by nesting. */
  readonly nested?: boolean;
}

/** More options than this and the list gets a search field. Fewer, and one would be noise. */
const SEARCH_FROM = 8;

interface Placed {
  readonly left: number;
  readonly top: number;
  readonly maxHeight: number;
}

/**
 * A panel tied to the button that opened it. Closes on Escape, on a press anywhere else,
 * and on a desk when the page underneath scrolls or resizes — a panel left floating where its
 * button used to be is pointing at nothing. Not on a phone, where it is a sheet along the
 * bottom edge and points at nothing to begin with; and there the on-screen keyboard coming up
 * for its find field resizes the page (Android) or scrolls it (iOS), which would close the
 * picker the moment the field was touched.
 *
 * The focus goes into it once it is drawn: to the control marked `data-autofocus`, or the
 * first there is. Not by `autoFocus`, which React runs while the panel is still hidden for
 * measuring, and a hidden control cannot take the focus. Tab goes through its controls and,
 * past either end, closes it and puts the focus back on its button, the way a native picker
 * does; focus that leaves it any other way closes it too. A panel is the last thing on the
 * page, so Tab out of it would otherwise go to the browser and leave it drawn.
 */
export function Panel({ tiedTo, returnTo = tiedTo, onClose, label, width, children }: {
  readonly tiedTo: HTMLElement;
  /** Where the focus goes back to when it closes, when that is not what it hangs from: a ⋯
   *  whose menu hangs from the lifted copy of a held card. */
  readonly returnTo?: HTMLElement;
  readonly onClose: () => void;
  readonly label: string;
  readonly width: number;
  readonly children: ReactNode;
}) {
  const panel = useRef<HTMLDivElement | null>(null);
  const [placed, setPlaced] = useState<Placed | null>(null);
  const drawn = placed !== null;
  // On a phone the panel is a sheet along the bottom edge, and Back closes a sheet. On a desk
  // it is a small panel under a button, which Back has never been the way out of.
  const phone = useMedia(PHONE);
  useBackCloses(onClose, phone);

  useLayoutEffect(() => {
    const box = tiedTo.getBoundingClientRect();
    const gap = 4;
    const edge = 8;
    const below = window.innerHeight - box.bottom - gap - edge;
    const above = box.top - gap - edge;
    const height = panel.current?.offsetHeight ?? 0;
    // Under the button when it fits, above when it does not and there is more room there.
    const goUp = height > below && above > below;
    const maxHeight = Math.max(160, goUp ? above : below);
    const shown = Math.min(height, maxHeight);
    setPlaced({
      left: Math.max(edge, Math.min(box.left, window.innerWidth - width - edge)),
      top: goUp ? Math.max(edge, box.top - gap - shown) : box.bottom + gap,
      maxHeight,
    });
  }, [tiedTo, width]);

  useEffect(() => {
    const el = panel.current;
    if (!drawn || el === null || el.contains(document.activeElement)) return;
    (el.querySelector<HTMLElement>("[data-autofocus]") ?? tabbables(el)[0])?.focus();
  }, [drawn]);

  useEffect(() => {
    /**
     * Escape closes the panel and nothing behind it.
     *
     * It has to be a native listener in the capture phase, on the window. The panel is a
     * portal, so stopping a React event on it does not reach the window listener in
     * `App.tsx` that closes whatever surface is open — and that one shut the task sheet
     * along with the calendar, which is a panel taking the page down with it. Capture on
     * the window runs first, so this press is spent here.
     */
    const escape = (e: KeyboardEvent): void => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      e.preventDefault();
      onClose();
      returnTo.focus();
    };
    const outside = (e: PointerEvent): void => {
      const at = e.target as Node | null;
      if (at !== null && (panel.current?.contains(at) === true || tiedTo.contains(at))) return;
      onClose();
    };
    const moved = (e: Event): void => {
      // The panel's own list scrolling is not the page moving.
      if (e.target instanceof Node && panel.current?.contains(e.target) === true) return;
      onClose();
    };
    window.addEventListener("keydown", escape, true);
    window.addEventListener("pointerdown", outside, true);
    if (!phone) {
      window.addEventListener("scroll", moved, true);
      window.addEventListener("resize", onClose);
    }
    return () => {
      window.removeEventListener("keydown", escape, true);
      window.removeEventListener("pointerdown", outside, true);
      window.removeEventListener("scroll", moved, true);
      window.removeEventListener("resize", onClose);
    };
  }, [tiedTo, returnTo, onClose, phone]);

  return createPortal(
    <div
      ref={panel}
      className="picker"
      role="dialog"
      aria-label={label}
      onKeyDown={(e) => {
        if (e.key !== "Tab") return;
        // Spent here. A React event bubbles through the portal to whatever opened the panel,
        // and a sheet's own Tab trap there would read this press as one inside itself.
        e.stopPropagation();
        const items = tabbables(e.currentTarget);
        const at = document.activeElement instanceof HTMLElement ? items.indexOf(document.activeElement) : -1;
        const next = at + (e.shiftKey ? -1 : 1);
        if (at >= 0 && next >= 0 && next < items.length) return;
        e.preventDefault();
        onClose();
        returnTo.focus();
      }}
      onBlur={(e) => {
        const to = e.relatedTarget;
        if (to instanceof Node && !e.currentTarget.contains(to) && !tiedTo.contains(to) && !returnTo.contains(to)) onClose();
      }}
      style={{
        width,
        left: placed?.left ?? 0,
        top: placed?.top ?? 0,
        maxHeight: placed?.maxHeight,
        visibility: placed === null ? "hidden" : "visible",
      }}
    >
      {children}
    </div>,
    document.body,
  );
}

/**
 * The button a picker hangs from. It shows what is chosen and a chevron, because a control
 * that looks like a label is the fault being fixed.
 */
function PickButton({ open, onToggle, label, children, className, icon = "lucide:chevron-down", buttonRef, extra }: {
  readonly open: boolean;
  readonly onToggle: () => void;
  readonly label: string;
  readonly children: ReactNode;
  readonly className?: string | undefined;
  readonly icon?: string;
  readonly buttonRef: (el: HTMLButtonElement | null) => void;
  readonly extra?: Readonly<Record<string, string>> | undefined;
}) {
  return (
    <button ref={buttonRef} type="button" className={`pick-button${open ? " open" : ""}${className === undefined ? "" : ` ${className}`}`}
      aria-haspopup="dialog" aria-expanded={open} aria-label={label} onClick={onToggle} {...extra}>
      <span className="pick-value">{children}</span>
      <span className="pick-mark"><Icon name={icon} size={14} /></span>
    </button>
  );
}

export function Pick({ label, value, options, onPick, placeholder = "Choose", className, width = 280, extra }: {
  /** What is being chosen, for a screen reader and for the search field: "project". */
  readonly label: string;
  readonly value: string | null;
  readonly options: readonly PickOption[];
  readonly onPick: (id: string) => void;
  /** What the button says when nothing is chosen, or when it is an action: "Link to…". */
  readonly placeholder?: string;
  readonly className?: string;
  readonly width?: number;
  /** Attributes for the button, for a surface that needs to find it again. */
  readonly extra?: Readonly<Record<string, string>>;
}) {
  const [tiedTo, tieTo] = useState<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const current = options.find((o) => o.id === value) ?? null;
  const searchable = options.length >= SEARCH_FROM;
  // On a phone the focus goes to a row, not the find field: a focused field brings the
  // on-screen keyboard up over half the list before anything has been looked for. The field
  // is a tap away.
  const phone = useMedia(PHONE);
  const findFirst = searchable && !phone;
  const needle = query.trim().toLowerCase();
  const shown = useMemo(
    () => (needle === "" ? options : options.filter((o) => o.name.toLowerCase().includes(needle) || (o.sub ?? "").toLowerCase().includes(needle))),
    [options, needle],
  );
  const close = (): void => { setOpen(false); setQuery(""); };
  const find = useRef<HTMLInputElement | null>(null);
  const list = useRef<HTMLDivElement | null>(null);

  return (
    <>
      <PickButton open={open} onToggle={() => (open ? close() : setOpen(true))} label={label}
        className={className} buttonRef={tieTo} extra={extra}>
        {current === null ? <span className="pick-empty">{placeholder}</span> : current.name}
      </PickButton>
      {open && tiedTo !== null && (
        <Panel tiedTo={tiedTo} onClose={close} label={label} width={width}>
          {searchable && (
            <div className="picker-find">
              <Icon name="lucide:search" size={14} />
              <input ref={find} data-autofocus={findFirst ? "" : undefined} value={query} placeholder={`Find a ${label}`} aria-label={`find a ${label}`}
                onChange={(e) => setQuery(e.target.value)}
                // Down from the field goes into what it found, as it would in any search.
                onKeyDown={(e) => {
                  if (e.key !== "ArrowDown") return;
                  e.preventDefault();
                  list.current?.querySelector<HTMLElement>(".picker-item")?.focus();
                }} />
            </div>
          )}
          <div ref={list} className="picker-list" role="listbox" aria-label={label}>
            {shown.map((o, i) => (
              <button key={o.id} type="button" role="option" aria-selected={o.id === value}
                // The chosen row, or the first, takes the focus when the search field does not,
                // so the arrow keys and Enter work without reaching for the pointer.
                data-autofocus={!findFirst && (current === null ? i === 0 : o.id === value) ? "" : undefined}
                className={`picker-item${o.id === value ? " on" : ""}${o.nested === true ? " nested" : ""}`}
                onKeyDown={(e) => {
                  if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
                  e.preventDefault();
                  const next = e.key === "ArrowDown" ? e.currentTarget.nextElementSibling : e.currentTarget.previousElementSibling;
                  // Up from the first row goes back to the field it was found with.
                  ((next as HTMLElement | null) ?? (e.key === "ArrowUp" ? find.current : null))?.focus();
                }}
                onClick={() => { close(); tiedTo.focus(); if (o.id !== value) onPick(o.id); }}>
                <span className="picker-name">{o.name}</span>
                {o.sub !== undefined && <span className="picker-sub">{o.sub}</span>}
                {o.id === value && <span className="picker-tick"><Icon name="lucide:check" size={14} /></span>}
              </button>
            ))}
            {shown.length === 0 && <div className="picker-none">Nothing matches.</div>}
          </div>
        </Panel>
      )}
    </>
  );
}

const sameMonth = (a: Month | null, b: Month): boolean => a !== null && a.year === b.year && a.month === b.month;

/**
 * The day a calendar's keyboard is on. One day of the month is in the Tab order, not all
 * thirty of them, and the arrow keys move it: a day either side, a week up or down, Page Up
 * and Page Down a month. Stepping off the month turns the page with it. Turned by its own
 * buttons instead, the keyboard's day is the 1st of the month now shown.
 */
function useDayRover(month: Month, setMonth: (to: Month) => void, start: string) {
  const [at, setAt] = useState(start);
  const grid = useRef<HTMLDivElement | null>(null);
  const moved = useRef(false);
  const roving = sameMonth(monthOf(at), month) ? at : `${month.year}-${String(month.month).padStart(2, "0")}-01`;
  useEffect(() => {
    if (!moved.current) return;
    moved.current = false;
    grid.current?.querySelector<HTMLElement>(`[data-date="${roving}"]`)?.focus();
  }, [roving]);
  const onKeyDown = (e: ReactKeyboardEvent): void => {
    const next = dayStep(roving, e);
    if (next === null) return;
    e.preventDefault();
    moved.current = true;
    setAt(next);
    const to = monthOf(next);
    if (to !== null && !sameMonth(to, month)) setMonth(to);
  };
  return { roving, grid, onKeyDown, reset: setAt };
}

/**
 * A day, chosen from a month. Decision 14.
 *
 * A pick saves at once and closes. "In a week" and "In a month" are there because they are
 * most of what a date is ever set to, and Clear is there because a date is optional and
 * taking one off should not need the keyboard.
 */
export function DatePick({ value, onSave, label, note, compact = false, className }: {
  readonly value: string | null;
  readonly onSave: (next: string | null) => void;
  readonly label: string;
  /** Said under the grid. A milestone's date is soft, and this is where it says so. */
  readonly note?: string;
  /** Where the date is already written beside it, the button says only that it changes it. */
  readonly compact?: boolean;
  /** Where it sits in something with its own look: the selection bar. */
  readonly className?: string;
}) {
  const [tiedTo, tieTo] = useState<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(false);
  const today = localToday();
  const [month, setMonth] = useState<Month>(() => monthOf(value ?? today) ?? { year: 2026, month: 1 });
  const weeks = useMemo(() => monthGrid(month.year, month.month), [month]);
  const rover = useDayRover(month, setMonth, value ?? today);

  const toggle = (): void => {
    // Open on the month the date is in, or on this one. Not on wherever it was left.
    if (!open) {
      setMonth(monthOf(value ?? today) ?? month);
      rover.reset(value ?? today);
    }
    setOpen(!open);
  };
  const pick = (next: string | null): void => {
    setOpen(false);
    tiedTo?.focus();
    if (next !== value) onSave(next);
  };

  return (
    <>
      <PickButton open={open} onToggle={toggle} label={label} icon="lucide:calendar" buttonRef={tieTo} className={className}>
        {compact ? (value === null ? "Set" : "Change") : value === null ? <span className="pick-empty">No date</span> : shortDate(value, today)}
      </PickButton>
      {open && tiedTo !== null && (
        <Panel tiedTo={tiedTo} onClose={() => setOpen(false)} label={label} width={300}>
          <div className="cal">
            <div className="cal-top">
              <button type="button" className="cal-step" aria-label="previous month" onClick={() => setMonth(shiftMonth(month, -1))}>
                <Icon name="lucide:chevron-left" size={16} />
              </button>
              <span className="cal-title" aria-live="polite">{monthTitle(month)}</span>
              <button type="button" className="cal-step" aria-label="next month" onClick={() => setMonth(shiftMonth(month, 1))}>
                <Icon name="lucide:chevron-right" size={16} />
              </button>
            </div>
            {/* A group of day buttons rather than a grid: a grid needs rows and cells, and a
                screen reader reads one without them as empty. */}
            <div ref={rover.grid} className="cal-grid" role="group" aria-label={monthTitle(month)} onKeyDown={rover.onKeyDown}>
              {WEEKDAYS.map((d) => <span key={d} className="cal-dow" aria-hidden="true">{d.slice(0, 2)}</span>)}
              {weeks.flat().map((cell) => (
                <button key={cell.date} type="button" data-date={cell.date}
                  tabIndex={cell.date === rover.roving ? 0 : -1} data-autofocus={cell.date === rover.roving ? "" : undefined}
                  className={`cal-day${cell.inMonth ? "" : " out"}${cell.date === today ? " today" : ""}${cell.date === value ? " on" : ""}`}
                  aria-label={fullDate(cell.date)} aria-pressed={cell.date === value} aria-current={cell.date === today ? "date" : undefined}
                  onClick={() => pick(cell.date)}>
                  {cell.day}
                </button>
              ))}
            </div>
            <div className="cal-quick">
              <Chip onClick={() => pick(today)}>Today</Chip>
              <Chip onClick={() => pick(addDays(today, 7))}>In a week</Chip>
              <Chip onClick={() => pick(addDays(today, 30))}>In a month</Chip>
              {value !== null && <Chip onClick={() => pick(null)}>Clear</Chip>}
            </div>
            {note !== undefined && <div className="cal-note">{note}</div>}
          </div>
        </Panel>
      )}
    </>
  );
}

/**
 * A month laid out in the page rather than in a panel: Add's "Pick a date" (VEMI-006). Seven
 * across under the same day names as the panel's calendar, the days before today quieter,
 * today ringed as the panel rings it, the chosen one in the accent. It steps a month at a
 * time; nothing about it is compared with a clock.
 */
export function MonthGrid({ value, today, onPick }: {
  readonly value: string | null;
  readonly today: string;
  readonly onPick: (date: string) => void;
}) {
  const [month, setMonth] = useState<Month>(() => monthOf(value ?? today) ?? { year: 2026, month: 1 });
  const weeks = useMemo(() => monthGrid(month.year, month.month), [month]);
  const rover = useDayRover(month, setMonth, value ?? today);
  return (
    <div className="month">
      <div className="month-top">
        <span className="month-title" aria-live="polite">{monthTitle(month)}</span>
        <button type="button" className="month-step" aria-label="previous month" onClick={() => setMonth(shiftMonth(month, -1))}>
          <Icon name="lucide:chevron-left" size={16} />
        </button>
        <button type="button" className="month-step" aria-label="next month" onClick={() => setMonth(shiftMonth(month, 1))}>
          <Icon name="lucide:chevron-right" size={16} />
        </button>
      </div>
      <div ref={rover.grid} className="month-grid" role="group" aria-label={monthTitle(month)} onKeyDown={rover.onKeyDown}>
        {WEEKDAYS.map((d) => <span key={d} className="month-dow" aria-hidden="true">{d.slice(0, 2)}</span>)}
        {weeks.flat().map((cell) => cell.inMonth ? (
          <button key={cell.date} type="button" data-date={cell.date} tabIndex={cell.date === rover.roving ? 0 : -1}
            className={`month-day${cell.date < today ? " past" : ""}${cell.date === today ? " today" : ""}${cell.date === value ? " on" : ""}`}
            aria-label={fullDate(cell.date)} aria-pressed={cell.date === value} aria-current={cell.date === today ? "date" : undefined}
            // The day pressed is the one the keyboard is on from here.
            onClick={() => { rover.reset(cell.date); onPick(cell.date); }}>
            {cell.day}
          </button>
        ) : <span key={cell.date} className="month-day out" aria-hidden="true" />)}
      </div>
    </div>
  );
}
