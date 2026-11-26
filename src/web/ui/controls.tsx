import { useEffect, useId, useRef, useState, type ClipboardEvent, type KeyboardEvent, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import type { StateKind } from "@vemi/shared";
import { answered, shownValue, type Saving } from "../fieldSave.js";
import type { Outcome } from "../outcome.js";
import { pastedLines } from "../pastedLines.js";
import { holdEntry, releaseEntry, steppedOff } from "../sheetHistory.js";
import { onWaiting, queued } from "../state/outbox.js";
import { readsBegun, useReadSince } from "../state/resources.js";
import { SmartChips } from "./SmartChips.js";
import { useSmartTitle, type SmartPicked } from "./useSmartTitle.js";

/** What a plain add line read from its text: nothing. */
const NOTHING_READ: SmartPicked = { dueOn: null, repeat: null, remindAt: null };

export function Label({ children }: { readonly children: ReactNode }) {
  return <div className="label">{children}</div>;
}

/** A state's kind as its dot, or blocked, which is a task's rather than a state's and wears ink. */
export function StateDot({ kind }: { readonly kind: StateKind | "blocked" }) {
  return <span className={`dot dot-${kind}`} aria-hidden="true" />;
}

export function Pending({ error, onRetry }: { readonly error: string | null; readonly onRetry: () => void }) {
  return (
    <div className="pending">
      {error === null ? <span className="data dim">Loading</span> : (
        <>
          <span role="alert">{error}</span>
          <button type="button" className="link-button" onClick={onRetry}>Try again</button>
        </>
      )}
    </div>
  );
}

/** When the component that calls this goes away, focus goes back to where it was before it came. */
export function useFocusReturn(): void {
  // Read while rendering: by the time an effect runs, an autofocused field inside has the focus.
  const [before] = useState(() => (document.activeElement instanceof HTMLElement ? document.activeElement : null));
  useEffect(() => () => {
    if (before !== null && before.isConnected) before.focus();
  }, [before]);
}

const FOCUSABLE = "button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])";

/**
 * What Tab reaches inside an element, in order: drawn, enabled, and not taken out of the
 * order — a calendar's other days and a menu's lines are reached by the arrow keys instead.
 */
export function tabbables(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.tabIndex >= 0 && el.getClientRects().length > 0);
}

/**
 * Tab and shift-Tab go round inside a dialog rather than out to the page behind it. With
 * the focus on the dialog itself, which is where it starts when nothing in it asks for it,
 * Tab goes to its first control and shift-Tab to its last.
 */
export function trapTab(event: KeyboardEvent<HTMLElement>): void {
  if (event.key !== "Tab") return;
  const items = tabbables(event.currentTarget);
  const first = items[0];
  const last = items.at(-1);
  if (first === undefined || last === undefined) return;
  const at = document.activeElement instanceof HTMLElement ? items.indexOf(document.activeElement) : -1;
  if (event.shiftKey && at <= 0) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && (at < 0 || at === items.length - 1)) {
    event.preventDefault();
    first.focus();
  }
}

/**
 * Back closes what calls this, while `on`: see `sheetHistory.ts`. Back steps off the entry
 * it pushed and calls `onClose`; closed any other way, it spends that entry itself.
 */
export function useBackCloses(onClose: () => void, on = true): void {
  const id = useId();
  const close = useRef(onClose);
  useEffect(() => {
    close.current = onClose;
  }, [onClose]);
  useEffect(() => {
    if (!on) return;
    holdEntry(id);
    const popped = (): void => {
      if (steppedOff(id)) close.current();
    };
    window.addEventListener("popstate", popped);
    return () => {
      window.removeEventListener("popstate", popped);
      releaseEntry(id);
    };
  }, [id, on]);
}

/**
 * What a field does with a save's answer. A save that did not happen puts the field back
 * into editing with what was typed, so "What you changed is still here" is true: the text
 * is on screen, and leaving the field again sends it again. Not focused when it reopens,
 * because by then the person may be typing somewhere else.
 *
 * A save that did happen is held until the screen has been read again after it: at once
 * when the Worker answered, and for one this device kept, once the outbox has nothing left
 * to send. Then whatever `value` is, the Worker holds it, even when that is the old text.
 */
export function useSaving(value: string | null, reopen: (text: string) => void) {
  // What is shown while the save is out, and when it gives way: `fieldSave.ts`.
  const [saving, setSaving] = useState<Saving | null>(null);
  const readAgain = useReadSince(saving?.after ?? null);
  useEffect(() => {
    if (answered(value, saving, readAgain)) setSaving(null);
  }, [value, saving, readAgain]);
  // A kept save waits on the outbox; a field that goes stops waiting with it.
  const waits = useRef(new Set<() => void>());
  useEffect(() => () => {
    for (const stop of waits.current) stop();
  }, []);
  const save = (text: string, sent: Promise<Outcome | boolean> | void): void => {
    if (sent === undefined) return;
    const pending: Saving = { text, from: value, after: null };
    setSaving(pending);
    const left = (): void => setSaving((s) => (s === pending ? { ...pending, after: readsBegun() } : s));
    void sent.then((ok) => {
      if (ok === false) {
        setSaving((s) => (s === pending ? null : s));
        reopen(text);
      } else if (ok !== "kept" || queued().length === 0) {
        left();
      } else {
        const stop = onWaiting((waiting) => {
          if (waiting > 0) return;
          stop();
          waits.current.delete(stop);
          left();
        });
        waits.current.add(stop);
      }
    });
  };
  return { shown: shownValue(value, saving), save };
}

/**
 * Text that is read until it is clicked, and edited until Enter or a click away. Escape
 * puts it back and goes no further, so it does not also close whatever it sits in.
 *
 * `onSave` is told what was on screen before, as well as what was typed: the way back for
 * undo. The record a caller holds can be a save behind what the field shows.
 *
 * A field reopened by a save that did not happen closes by itself once `value` arrives at
 * what it holds: the notice's Try again sent it, and there is nothing left to leave.
 *
 * Left by Enter or Escape, the focus goes back to the text it was opened from: the field
 * that had it is gone, and focus dropped on the page would put a keyboard outside the task
 * sheet it was working in. Left by a click elsewhere, the focus stays where the click put it.
 */
export function EditableText({ value, onSave, placeholder, multiline = false, allowEmpty = false, className }: {
  readonly value: string | null;
  /** Answers what became of the save, so a save that did not happen can be put back to edit. */
  readonly onSave: (next: string, was: string | null) => Promise<Outcome | boolean> | void;
  readonly placeholder: string;
  readonly multiline?: boolean;
  readonly allowEmpty?: boolean;
  readonly className?: string;
}) {
  const [editing, setEditing] = useState(false);
  const [focusing, setFocusing] = useState(true);
  const [draft, setDraft] = useState(value ?? "");
  const [reopened, setReopened] = useState(false);
  const reading = useRef<HTMLButtonElement>(null);
  const backByKey = useRef(false);
  const { shown, save } = useSaving(value, (text) => {
    setDraft(text);
    setFocusing(false);
    setReopened(true);
    setEditing(true);
  });
  useEffect(() => {
    if (!editing) setDraft(shown ?? "");
  }, [shown, editing]);
  useEffect(() => {
    if (!reopened) return;
    if (!editing) setReopened(false);
    else if (draft.trim() === (value ?? "").trim()) setEditing(false);
  }, [reopened, editing, draft, value]);
  useEffect(() => {
    if (editing || !backByKey.current) return;
    backByKey.current = false;
    reading.current?.focus();
  }, [editing]);

  if (!editing) {
    return (
      <button ref={reading} type="button" dir="auto" className={`editable ${className ?? ""}`} onClick={() => { setFocusing(true); setEditing(true); }}>
        {shown !== null && shown !== "" ? shown : <span className="placeholder">{placeholder}</span>}
      </button>
    );
  }

  const commit = (): void => {
    setEditing(false);
    const next = draft.trim();
    if (next === (shown ?? "").trim()) return;
    if (next === "" && !allowEmpty) return;
    save(next, onSave(next, shown));
  };
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>): void => {
    if (e.key === "Escape") {
      e.stopPropagation();
      backByKey.current = true;
      setDraft(shown ?? "");
      setEditing(false);
    } else if (e.key === "Enter" && (!multiline || e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      backByKey.current = true;
      commit();
    }
  };

  return multiline ? (
    <textarea dir="auto" className={`editing ${className ?? ""}`} value={draft} autoFocus={focusing} rows={4} aria-label={placeholder}
      onChange={(e) => setDraft(e.target.value)} onBlur={commit} onKeyDown={onKeyDown} />
  ) : (
    <input dir="auto" className={`editing ${className ?? ""}`} value={draft} autoFocus={focusing} aria-label={placeholder}
      onChange={(e) => setDraft(e.target.value)} onBlur={commit} onKeyDown={onKeyDown} />
  );
}

/**
 * One line and a button: the shape of every "add" in the interface.
 *
 * Escape clears the line and leaves it, and goes no further: a line inside a sheet must not
 * close the sheet. A line that is itself opened and closed says so with `onEscape`, which
 * runs after, so Escape closes it the way it closes a board column's add.
 *
 * One add at a time. A second Enter, or Enter and then a press of the button, while the
 * first is still on its way is dropped, so a slow connection does not make two of a thing.
 * The line stays as typed until the add has answered, and stays if it did not happen.
 *
 * A line that takes `onAddMany` makes one item a line from a paste of several lines
 * (`pastedLines.ts`), and leaves what was already typed where it is.
 */
export function AddLine({ placeholder, onAdd, onAddMany, label = "Add", onEscape, smart = false, cue = false }: {
  readonly placeholder: string;
  /** With `smart`, `text` is the title left after the date, repeat and time words, and `read` is what they meant. */
  readonly onAdd: (text: string, read: SmartPicked) => Promise<Outcome | boolean> | void;
  readonly onAddMany?: (lines: readonly string[]) => Promise<unknown> | void;
  readonly label?: string;
  readonly onEscape?: () => void;
  /** Read the typed text for dates, repeats and times, and show a chip for each. */
  readonly smart?: boolean;
  /** First run's mark: the accent ring, and the line takes focus while it holds. */
  readonly cue?: boolean;
}) {
  const reading = useSmartTitle();
  const { text, setText } = reading;
  const field = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (cue) field.current?.focus();
  }, [cue]);
  // The ref drops the second submit at once; the state draws the button as busy.
  const busy = useRef(false);
  const [adding, setAdding] = useState(false);
  const submit = async (): Promise<void> => {
    const t = text.trim();
    if (t === "" || busy.current) return;
    busy.current = true;
    setAdding(true);
    try {
      const ok = smart ? await onAdd(reading.title.trim(), reading.picked) : await onAdd(t, NOTHING_READ);
      if (ok !== false) setText("");
    } finally {
      busy.current = false;
      setAdding(false);
    }
  };
  return (
    <>
    <form className={cue ? "add-line first-run-cue" : "add-line"} onSubmit={(e) => { e.preventDefault(); void submit(); }}>
      <input ref={field} dir="auto" value={text} placeholder={placeholder} aria-label={placeholder} onChange={(e) => setText(e.target.value)}
        onPaste={onAddMany === undefined ? undefined : pastedMany(onAddMany)}
        onKeyDown={(e) => {
          if (e.key !== "Escape") return;
          e.stopPropagation();
          setText("");
          (e.target as HTMLInputElement).blur();
          onEscape?.();
        }} />
      <button type="submit" className="quiet-button" disabled={adding || text.trim() === ""}>{label}</button>
    </form>
    {smart && <SmartChips chips={reading.chips} onRestore={reading.restore} />}
    </>
  );
}

/**
 * A paste handler for a one-line field that makes one item a line instead. An ordinary
 * paste of one line goes into the field as any paste does.
 */
export const pastedMany = (onMany: (lines: readonly string[]) => unknown) => (e: ClipboardEvent<HTMLInputElement>): void => {
  const lines = pastedLines(e.clipboardData.getData("text"));
  if (lines === null) return;
  e.preventDefault();
  void onMany(lines);
};

/**
 * The one grab point in a manual-order list. Decision 8: this replaces the arrow buttons.
 *
 * It means the same thing wherever it appears — drag me up or down this list — which is
 * what lets the row's body go on meaning open or move. It is a button, so it takes
 * focus and the arrow keys still work for anyone not holding a pointer.
 */
export function Grip(props: {
  readonly onPointerDown: (e: ReactPointerEvent) => void;
  readonly onKeyDown: (e: ReactKeyboardEvent) => void;
  readonly "aria-label": string;
  readonly title: string;
  readonly stacked?: boolean;
}) {
  const { stacked = false, ...rest } = props;
  return <button type="button" className={`grip${stacked ? " stacked" : ""}`} {...rest}>⠿</button>;
}

/**
 * What a screen reader is told as it changes, and drawn nowhere. It is on the page before
 * it has anything to say and stays after: a live region that arrives already holding its
 * words is one a screen reader often never reads, so the notice and the status line, which
 * come and go, are drawn for the eye and said through one of these.
 */
export function Spoken({ text }: { readonly text: string }) {
  return <div className="sr-only" role="status">{text}</div>;
}
