import { useEffect, useMemo, useRef, useState } from "react";
import type { Tag } from "@vemi/shared";
import { ApiError, api, paths } from "../api.js";
import type { Outcome } from "../outcome.js";
import { endedSession, useResource } from "../state/resources.js";
import { tagIndex } from "../tagIndex.js";
import { Chip } from "./Chip.js";
import { Sheet } from "./Sheet.js";

/**
 * Tags, chosen from what already exists.
 *
 * A tag is the first thing in this tool with real upkeep, and it earns its place by being
 * few and reused. So the picker shows what exists first, always, and only offers to make a
 * new one when what has been typed names none of them — last row, never the first option,
 * and never what Enter does while a match is there to be chosen. A picker that offers "make
 * it" before "you already have it" grows a hundred tags in a month, and then the tags mean
 * nothing and the upkeep is all that is left.
 *
 * **Tags are monochrome, and there is nothing here that could carry a colour.** Every tool
 * in this category gives each tag its own hue; doing it here would make orange one of
 * fourteen things instead of "this wants you", and colour in this interface carries state
 * and nothing else. `tests/one-palette.test.ts` would fail the build over a hex, but the
 * reason is the point, not the guard. If two tags need telling apart, that is what the
 * words are for.
 *
 * Assignment is an ordinary patch of the record's whole `tagIds`, so undo comes free. The
 * store spares the join rows of archived tags, so a write replaces only the tags the picker
 * was actually shown.
 */

/** What carries the tags, and how a picker of them is built. */
export interface TagHolder {
  /** The ids the record holds, as it was last read. */
  readonly tagIds: readonly string[];
  /**
   * Write the whole list. Answers whether the Worker took it.
   *
   * `was` is the list this choice replaces, and the way back belongs to it rather than to
   * the record: the record still holds whatever the Worker last sent, which is a choice
   * behind while a write is in flight. Build the step's `undo` from `was`.
   */
  readonly onChange: (next: readonly string[], was: readonly string[]) => Promise<Outcome | boolean>;
  /** The word for what carries them: "task", "project". */
  readonly of: string;
}

/**
 * The section a surface shows: what is on this record, and the way to change it.
 *
 * Tags travel whole, the way the checklist does, so two choices made in quick succession
 * would each be built from the last answer and each undo the other. Choices apply to what
 * is on screen and the writes go one after another — and so does the way back, which is
 * the list each choice replaced rather than the one the record still carries. Both halves
 * of a step come from what is on screen, or the second undo takes back the first.
 */
export function Tags({ tagIds, onChange, of }: TagHolder) {
  const tags = useResource<Tag[]>(paths.list("tags"));
  const [open, setOpen] = useState(false);
  const [ids, setIds] = useState<readonly string[]>(tagIds);
  const sending = useRef(0);
  const chain = useRef<Promise<unknown>>(Promise.resolve());
  useEffect(() => {
    if (sending.current === 0) setIds(tagIds);
  }, [tagIds]);

  const put = (next: readonly string[]): Promise<Outcome | boolean> => {
    // The way back is the list this choice replaces, held here rather than read off the
    // record when the write lands: by then the record is one choice behind, and two quick
    // choices would each offer the same way back — one undo would take both tags off and
    // the next would do nothing. The same capture the checklist makes. Decision 20.
    const was = ids;
    setIds(next);
    sending.current += 1;
    const run = chain.current.then(() => onChange(next, was));
    chain.current = run.finally(() => {
      sending.current -= 1;
    });
    return run;
  };

  const all = tags.data ?? [];
  const chosen = useMemo(() => tagIndex(all, ids, "").chosen, [all, ids]);

  return (
    <>
      <div className="detail-row-head">
        <span className="kicker">Tags</span>
        <button type="button" className="row-action" onClick={() => setOpen(true)}>
          {chosen.length === 0 ? "Add" : "Change"}
        </button>
      </div>
      {chosen.length === 0
        ? <div className="more-empty">None.</div>
        : <div className="chips pills">{chosen.map((tag) => <span key={tag.id} className="pill">{tag.name}</span>)}</div>}
      {open && <TagPicker tags={all} ids={ids} of={of} onPut={put} onClose={() => setOpen(false)} />}
    </>
  );
}

/** The picker itself, on the `Sheet` every other sheet in the interface is built on. */
function TagPicker({ tags, ids, of, onPut, onClose }: {
  readonly tags: readonly Tag[];
  readonly ids: readonly string[];
  readonly of: string;
  readonly onPut: (next: readonly string[]) => Promise<Outcome | boolean>;
  readonly onClose: () => void;
}) {
  const [typed, setTyped] = useState("");
  const [said, setSaid] = useState<string | null>(null);
  const [making, setMaking] = useState(false);
  const list = useRef<HTMLDivElement | null>(null);
  const index = useMemo(() => tagIndex(tags, ids, typed), [tags, ids, typed]);
  const word = typed.trim();
  /** The last row, and only while the typed word names no tag at all. */
  const offerNew = word !== "" && index.exact === null;

  const take = (id: string): void => {
    setSaid(null);
    void onPut(ids.includes(id) ? ids.filter((held) => held !== id) : [...ids, id]);
  };

  /**
   * A chip or a match pressed is a button that goes: the tag moves to the other list. The
   * focus goes to the one that took its place, or the one before it at the end of the row,
   * or the field when the row is empty — never dropped on the page behind the sheet.
   */
  const chosenRow = useRef<HTMLDivElement | null>(null);
  const field = useRef<HTMLInputElement | null>(null);
  const refocus = useRef<{ readonly row: "chosen" | "matches"; readonly at: number } | null>(null);
  const takeFrom = (row: "chosen" | "matches", at: number, id: string): void => {
    refocus.current = { row, at };
    take(id);
  };
  useEffect(() => {
    const was = refocus.current;
    if (was === null) return;
    refocus.current = null;
    const row = was.row === "chosen" ? chosenRow.current : list.current;
    const buttons = row === null ? [] : [...row.querySelectorAll<HTMLElement>("button")];
    (buttons[Math.min(was.at, buttons.length - 1)] ?? field.current)?.focus();
  }, [index]);

  const make = async (): Promise<void> => {
    if (!offerNew || making) return;
    setMaking(true);
    setSaid(null);
    // The id is chosen here rather than by the Worker, so a create replayed from the outbox
    // lands on the first one instead of making a second tag of the same name — and so the
    // assignment below can be written while the create is still waiting on a connection.
    const id = crypto.randomUUID();
    try {
      await api.create("tags", { id, name: word });
    } catch (err) {
      setMaking(false);
      if (endedSession(err)) return;
      // A duplicate name comes back 409. The store's sentence is about a constraint; this
      // one is about a tag, which is what the person was looking at.
      setSaid(err instanceof ApiError && err.status === 409
        ? "There is already a tag called that."
        : err instanceof Error ? err.message : "That tag did not save.");
      return;
    }
    setMaking(false);
    setTyped("");
    void onPut([...ids, id]);
  };

  /**
   * Enter in the field never makes a tag while one already exists to be chosen: an exact
   * name is taken, matches send the focus to the first of them, and only a word that names
   * nothing at all reaches "make a new tag".
   *
   * It only ever adds. A field labelled "Find a tag" is typed into to put a tag on, and a
   * tag already here is often above the fold or simply unread, so Enter on one leaves it
   * where it is instead of quietly taking it off behind a notice that says the tags
   * changed. Taking one off is its chosen chip, which is the thing that looks removable.
   */
  const submit = (): void => {
    if (index.exact !== null) {
      if (!ids.includes(index.exact.id)) take(index.exact.id);
      setTyped("");
      return;
    }
    if (index.matches.length > 0) {
      list.current?.querySelector("button")?.focus();
      return;
    }
    void make();
  };

  return (
    <Sheet onClose={onClose} className="pill-sheet" placement="centre" label="tags">
      <div className="sheet-head">
        <span className="kicker">Tags</span>
        <span className="fill" />
        <button type="button" className="close-button" aria-label="close" onClick={onClose}>×</button>
      </div>
      <div className="sheet-body">
        <div className="sheet-section">
          <div className="kicker">On this {of}</div>
          {index.chosen.length === 0
            ? <div className="more-empty">None yet.</div>
            : (
              <div ref={chosenRow} className="chips pill-chosen">
                {index.chosen.map((tag, i) => (
                  <Chip key={tag.id} on aria-label={`take ${tag.name} off this ${of}`}
                    onClick={() => takeFrom("chosen", i, tag.id)}>{tag.name}<span aria-hidden="true">×</span></Chip>
                ))}
              </div>
            )}
        </div>

        <div className="sheet-section">
          <form onSubmit={(e) => { e.preventDefault(); submit(); }}>
            <input ref={field} className="field" autoFocus value={typed} placeholder="Find a tag" aria-label="find a tag"
              onChange={(e) => { setTyped(e.target.value); setSaid(null); }}
              onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); onClose(); } }} />
          </form>
          <div className="picker-list pill-list" ref={list}>
            {index.matches.map((tag, i) => (
              <button key={tag.id} type="button" className="picker-item"
                onKeyDown={(e) => {
                  if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
                  e.preventDefault();
                  const next = e.key === "ArrowDown" ? e.currentTarget.nextElementSibling : e.currentTarget.previousElementSibling;
                  (next as HTMLElement | null)?.focus();
                }}
                onClick={() => takeFrom("matches", i, tag.id)}>
                <span className="picker-name">{tag.name}</span>
              </button>
            ))}
            {index.matches.length === 0 && (
              <div className="picker-none">{tags.length === 0 ? "No tags yet." : "Nothing else matches."}</div>
            )}
          </div>
          {/* Last, and only while nothing is named exactly. Never the first option. */}
          {offerNew && (
            <button type="button" className="picker-item pill-new" disabled={making} onClick={() => void make()}>
              <span className="picker-name">Make a new tag: {word}</span>
            </button>
          )}
          {said !== null && <div className="pill-said" role="alert">{said}</div>}
        </div>
      </div>
    </Sheet>
  );
}
