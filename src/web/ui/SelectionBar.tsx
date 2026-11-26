import { useLayoutEffect, useRef, type ReactNode } from "react";
import { type DateOnly, type Tag, type TaskWithBlocker } from "@vemi/shared";
import { useLevelWords } from "../levelNames.js";
import { tagChange, ventureMoves, type Change } from "../bulkEdit.js";
import { shortDate } from "../format.js";
import { DatePick } from "./Picker.js";

/**
 * What to do with what is selected: the handoff's dark bar at the foot of the page, the
 * count, a rule, the actions, then Clear.
 *
 * Every action is a button or a visible picker. Nothing here is behind a right-click, and
 * nothing is behind a gesture: decision 13, and the reason for it.
 *
 * A notice can be said while the bar is up, and both sit at the foot of the page. The bar
 * says how tall it is drawn as `--selection-bar-h` on the root, so the stylesheet stands the
 * notice on top of it rather than over its actions, however many lines the bar wraps to.
 */
export function SelectionBar({ what, onClear, children }: {
  /** "3 tasks", already counted. */
  readonly what: string;
  readonly onClear: () => void;
  readonly children: ReactNode;
}) {
  const bar = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    const el = bar.current;
    if (el === null) return;
    const root = document.documentElement;
    const say = (): void => root.style.setProperty("--selection-bar-h", `${el.offsetHeight}px`);
    say();
    const sizes = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(say);
    sizes?.observe(el);
    return () => {
      sizes?.disconnect();
      root.style.removeProperty("--selection-bar-h");
    };
  }, []);
  return (
    <div ref={bar} className="selection-bar" role="toolbar" aria-label={`actions for ${what}`}>
      <span className="selection-count">{what}</span>
      <span className="selection-rule" aria-hidden="true" />
      {children}
      <button type="button" className="bar-action" onClick={onClear}>Clear</button>
    </div>
  );
}

/** A picker in the bar: a label and a set of buttons, never a native dropdown. */
export function BarPick({ label, options, onPick }: {
  readonly label: string;
  readonly options: readonly { readonly id: string; readonly name: string }[];
  readonly onPick: (id: string) => void;
}) {
  if (options.length === 0) return null;
  return (
    <span className="bar-pick">
      <span className="bar-label">{label}</span>
      {options.map((o) => (
        <button key={o.id} type="button" className="bar-action" onClick={() => onPick(o.id)}>{o.name}</button>
      ))}
    </span>
  );
}

/**
 * The picks every task bar carries besides its own: state, size, due date, today, a tag on or
 * off, and another venture. Each is one write over what is selected, through the bar's own
 * `onPatch` (one patch for all) or `onChange` (a patch a record), and undone per record.
 */
export function TaskBarPicks({ picked, states, tags, ventures, today, onPatch, onChange }: {
  /** What is selected. */
  readonly picked: readonly TaskWithBlocker[];
  /** The venture's states, in order; none when the bar sets state some other way. */
  readonly states: readonly { readonly id: string; readonly name: string }[];
  /** Every tag there is, to put one on. */
  readonly tags: readonly Tag[];
  /** The ventures the selection could move to, in order. */
  readonly ventures: readonly { readonly id: string; readonly name: string }[];
  readonly today: DateOnly | null;
  readonly onPatch: (patch: Readonly<Record<string, unknown>>, what: string) => void;
  readonly onChange: (change: Change, what: string) => void;
}) {
  const w = useLevelWords();
  const named = (id: string): string => tags.find((t) => t.id === id)?.name ?? "that tag";
  // Only a tag something selected carries can be taken off, in the order the tags are in.
  const carried = tags.filter((t) => picked.some((task) => task.tagIds.includes(t.id)));
  return (
    <>
      <BarPick label="State" options={states}
        onPick={(id) => onPatch({ stateId: id }, `moved to ${states.find((st) => st.id === id)?.name ?? "that state"}`)} />
      <span className="bar-pick">
        <span className="bar-label">Due</span>
        <DatePick compact value={null} label="due date for what is selected" className="bar-action bar-date"
          onSave={(dueOn) => { if (dueOn !== null) onPatch({ dueOn }, `due ${shortDate(dueOn, today)}`); }} />
        <button type="button" className="bar-action" onClick={() => onPatch({ dueOn: null }, "date cleared")}>none</button>
      </span>
      <span className="bar-pick">
        <span className="bar-label">Today</span>
        <button type="button" className="bar-action" disabled={today === null} onClick={() => onPatch({ pickedOn: today }, "put on today")}>Put on</button>
        <button type="button" className="bar-action" onClick={() => onPatch({ pickedOn: null }, "taken off today")}>Take off</button>
      </span>
      <BarPick label="Tag" options={tags.map((t) => ({ id: t.id, name: t.name }))}
        onPick={(id) => onChange(tagChange(picked, id, true), `tagged ${named(id)}`)} />
      <BarPick label="Untag" options={carried.map((t) => ({ id: t.id, name: t.name }))}
        onPick={(id) => onChange(tagChange(picked, id, false), `${named(id)} taken off`)} />
      <BarPick label={w.space} options={ventures}
        onPick={(id) => onChange(ventureMoves(picked, id), `moved to ${ventures.find((v) => v.id === id)?.name ?? `that ${w.space.toLowerCase()}`}`)} />
    </>
  );
}
