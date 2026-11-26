import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from "react";
import type { Outcome } from "../outcome.js";
import { renderMarkdown } from "../renderMarkdown.js";
import { useSaving } from "./controls.js";
import { MarkdownBlocks } from "./MarkdownBlocks.js";

/**
 * A task's body: read as blocks, written as markdown, with three controls and never a fourth.
 *
 * Markdown is the storage format so that what is written here outlives this application, and
 * the three constructs the sheet renders — a heading, a list, a link — are the three controls.
 * **There is no fourth, ever.** A fourth control means a fourth construct, which means the
 * reader grows a grammar, the field grows a toolbar, and the document editor this tool
 * refused arrives one button at a time. Three, and plain text underneath.
 *
 * It is its own component rather than a mode of `EditableText`, which cannot carry a toolbar:
 * that control commits on blur before a button's click lands, keeps no ref to its field so
 * nothing can read the caret, reads as a `<button>` — inside which a rendered link is not
 * clickable — and trims the trailing newline markdown means.
 *
 * Blocks are mapped to React elements. Nothing here calls `dangerouslySetInnerHTML`, which is
 * the whole reason `renderMarkdown.ts` answers in data rather than in HTML.
 */

/** The line marks, in the order the controls sit. One line carries at most one of them. */
const MARKS = ["## ", "- "] as const;

/** A line without whichever mark it carries, so Heading and List replace one another. */
function bare(line: string): string {
  for (const mark of MARKS) if (line.startsWith(mark)) return line.slice(mark.length);
  return line;
}

/**
 * The body as it is stored: the trailing blank lines come down to one newline, and nothing
 * else is touched.
 *
 * `EditableText`'s `trim()` is the wrong rule here. The blank line that ends a paragraph and
 * the spacing of a list are the writing, not padding around it, and a `trim()` at the end of
 * every edit would quietly rewrite the author's text each time the field lost the focus.
 */
function tidy(text: string): string {
  const said = text.replace(/\s+$/, "");
  return said === "" ? "" : `${said}\n`;
}

/** The whole lines the selection touches, as offsets into the text. */
function lineSpan(text: string, from: number, to: number): readonly [number, number] {
  const start = from === 0 ? 0 : text.lastIndexOf("\n", from - 1) + 1;
  // A selection that ends on a line's first character has not reached that line.
  const last = to > from && text[to - 1] === "\n" ? to - 1 : to;
  const after = text.indexOf("\n", last);
  return [start, after === -1 ? text.length : after];
}

export function MarkdownField({ value, placeholder, label, onSave }: {
  readonly value: string | null;
  readonly placeholder: string;
  /** What this body is, for a screen reader: "body". */
  readonly label: string;
  /**
   * Answers what became of the save, so a save that did not happen can be put back to edit.
   * `was` is the body on screen before it, the way back for undo (as `EditableText`'s).
   */
  readonly onSave: (next: string, was: string | null) => Promise<Outcome | boolean> | void;
}) {
  const [editing, setEditing] = useState(false);
  const [focusing, setFocusing] = useState(true);
  const [draft, setDraft] = useState(value ?? "");
  const [reopened, setReopened] = useState(false);
  // A body is up to 20,000 characters. One that did not save comes back to edit as written,
  // rather than living on only in a notice's Try again (`useSaving` in controls.tsx).
  const { shown, save } = useSaving(value, (text) => {
    setDraft(text);
    setFocusing(false);
    setReopened(true);
    setEditing(true);
  });
  // Reopened, and then sent by the notice's Try again: the body is saved, so the field closes.
  useEffect(() => {
    if (!reopened) return;
    if (!editing) setReopened(false);
    else if (tidy(draft) === tidy(value ?? "")) setEditing(false);
  }, [reopened, editing, draft, value]);
  const field = useRef<HTMLTextAreaElement | null>(null);
  const around = useRef<HTMLDivElement | null>(null);
  /** Where the caret goes once the text a control wrote has been rendered. */
  const caret = useRef<readonly [number, number] | null>(null);
  const blocks = useMemo(() => renderMarkdown(shown), [shown]);
  const empty = blocks.length === 0;

  // A control that loses the caret is worse than no control, so the selection is set after
  // the render that carries the new text rather than on the text React has not written yet.
  useLayoutEffect(() => {
    const at = caret.current;
    const area = field.current;
    if (at === null || area === null) return;
    caret.current = null;
    area.focus();
    area.setSelectionRange(at[0], at[1]);
  });

  const start = (): void => {
    setDraft(shown ?? "");
    setFocusing(true);
    setEditing(true);
  };

  if (!editing) {
    return (
      <div className="md-field">
        {!empty && (
          <div className="md-head">
            <button type="button" className="row-action md-edit-action" onClick={start}>Edit</button>
          </div>
        )}
        {/* Not a button when there is anything in it: a region holding links cannot be one,
            and a link inside a button is not clickable. Empty, there are no links and the
            whole placeholder is the invitation, so there it is a button, says so, and takes
            the focus. With anything in it the region is not a stop at all: "Edit" above
            carries the affordance, it is already the stop before this one, and a region
            with no role and no name that announces only the body would be a second stop
            saying nothing. Its own links stay reachable inside it. */}
        <div className={`md-read${empty ? " md-blank" : ""}`}
          {...(empty ? { role: "button", "aria-label": `write the ${label}`, tabIndex: 0 } : {})}
          onClick={(e) => { if (!(e.target instanceof HTMLAnchorElement)) start(); }}
          onKeyDown={(e) => {
            // A link's own Enter opens the link; this is the region's own press.
            if (e.target !== e.currentTarget || (e.key !== "Enter" && e.key !== " ")) return;
            e.preventDefault();
            start();
          }}>
          {empty ? <span className="placeholder">{placeholder}</span> : <MarkdownBlocks blocks={blocks} />}
        </div>
      </div>
    );
  }

  const commit = (): void => {
    setEditing(false);
    const next = tidy(draft);
    if (next === tidy(shown ?? "")) return;
    save(next, onSave(next, shown));
  };

  /**
   * Leaving the field commits; moving between the field and its own controls does not.
   *
   * Without the second half a Tab from the textarea to Heading would commit, leave edit
   * mode and unmount the button being reached for, which makes the three controls
   * keyboard-unreachable — the same trap as the pointer's, arriving by another door.
   */
  const left = (e: { readonly relatedTarget: EventTarget | null }): void => {
    const to = e.relatedTarget;
    if (to instanceof Node && around.current?.contains(to) === true) return;
    commit();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key === "Escape") {
      // Stopped here, so leaving the field does not also close the sheet it sits in.
      e.stopPropagation();
      setDraft(shown ?? "");
      setEditing(false);
    } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      commit();
    }
  };

  /**
   * The press that must never land on the field's blur.
   *
   * `mousedown` moves the focus before `click` fires, so without this the textarea blurs,
   * commits, leaves edit mode, and the button is gone before the click reaches it. This is
   * the exact trap that makes a toolbar on `EditableText` impossible; here it is refused
   * deliberately. The default is prevented, the focus never moves, and the caret the
   * control is about to work on is still where the author left it.
   */
  const hold = (e: MouseEvent<HTMLButtonElement>): void => e.preventDefault();

  /** Heading and List: the mark goes on every line the selection touches, or comes off them all. */
  const markLines = (mark: string): void => {
    const area = field.current;
    if (area === null) return;
    const [from, to] = lineSpan(draft, area.selectionStart, area.selectionEnd);
    const lines = draft.slice(from, to).split("\n");
    const already = lines.every((line) => line.trim() === "" || line.startsWith(mark));
    const said = lines.map((line) => (line.trim() === "" ? line : already ? bare(line) : mark + bare(line))).join("\n");
    setDraft(draft.slice(0, from) + said + draft.slice(to));
    caret.current = [from, from + said.length];
  };

  /** Link: the selection becomes the words, and what is left to write is what is selected. */
  const linkHere = (): void => {
    const area = field.current;
    if (area === null) return;
    const from = area.selectionStart;
    const to = area.selectionEnd;
    const words = draft.slice(from, to);
    setDraft(`${draft.slice(0, from)}[${words}](url)${draft.slice(to)}`);
    caret.current = words === ""
      ? [from + 1, from + 1]
      : [from + words.length + 3, from + words.length + 6];
  };

  return (
    // `onBlur` is React's focusout and bubbles, so one handler covers the field and its
    // controls alike and each of them knows where the focus went.
    <div className="md-field" ref={around} onBlur={left}>
      <div className="md-tools" role="group" aria-label={`${label} controls`}>
        <button type="button" className="row-action md-tool" onMouseDown={hold} onClick={() => markLines("## ")}>Heading</button>
        <button type="button" className="row-action md-tool" onMouseDown={hold} onClick={() => markLines("- ")}>List</button>
        <button type="button" className="row-action md-tool" onMouseDown={hold} onClick={linkHere}>Link</button>
      </div>
      <textarea ref={field} dir="auto" className="editing md-write" value={draft} rows={6} autoFocus={focusing} aria-label={label}
        onChange={(e) => setDraft(e.target.value)} onKeyDown={onKeyDown} />
    </div>
  );
}
