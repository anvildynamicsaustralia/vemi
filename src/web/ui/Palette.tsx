import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { highlight, type Tree } from "@vemi/shared";
import { paths } from "../api.js";
import { useLevelWords } from "../levelNames.js";
import { paletteSections, type PaletteEntry } from "../paletteRows.js";
import { navigate } from "../router.js";
import { useResource } from "../state/resources.js";
import { indexTree, tasksOf } from "../treeIndex.js";
import { lastVenture, useApp } from "./appContext.js";
import { Sheet } from "./Sheet.js";
import "./palette.css";

/** The matched letters of a title, marked. */
function Marked({ text, typed }: { readonly text: string; readonly typed: string }) {
  return (
    <>
      {highlight(text, typed).map((part, i) => (part.match ? <mark key={i} className="palette-mark">{part.text}</mark> : <span key={i}>{part.text}</span>))}
    </>
  );
}

/**
 * The command palette: one field over a list of things to do and places to go (VEMI-013). Arrow
 * keys move, Enter runs the chosen row, Escape closes. Every row comes from the tree this
 * device holds, through `paletteRows.ts`; when nothing matches, the one row is a new task
 * named by what was typed, and the compose sheet reads the smart dates in it. The keys that
 * reach the same places are shown beside the rows on a desk and left out on a phone.
 */
export function Palette({ onClose }: { readonly onClose: () => void }) {
  const app = useApp();
  const tree = useResource<Tree>(paths.tree);
  const [typed, setTyped] = useState("");
  const [selected, setSelected] = useState(0);
  const list = useRef<HTMLDivElement>(null);
  const words = useLevelWords();

  const sections = useMemo(() => {
    const index = tree.data === null ? null : indexTree(tree.data);
    const lastId = lastVenture();
    const known = lastId === null ? undefined : index?.ventures.get(lastId);
    const ventures = tree.data?.ventures ?? [];
    return paletteSections(typed, {
      words,
      last: known === undefined ? null : { id: known.id, name: known.name },
      projects: ventures.flatMap((v) => v.projects),
      tasks: ventures.flatMap((v) => tasksOf(v).map((t) => ({ id: t.id, ventureId: v.id, title: t.title }))),
      spaceName: (id) => index?.ventures.get(id)?.name ?? "",
    });
  }, [tree.data, typed, words]);
  const rows = sections.flatMap((s) => s.rows);

  useEffect(() => setSelected(0), [typed]);
  useEffect(() => {
    const on = list.current?.querySelector(".palette-row.on");
    if (on instanceof HTMLElement && typeof on.scrollIntoView === "function") on.scrollIntoView({ block: "nearest" });
  }, [selected]);

  const run = (row: PaletteEntry): void => {
    if (typeof row.to === "object" && "pin" in row.to) return;
    onClose();
    if (row.to === "compose") {
      // The fallback row carries the typed text in `where`; the plain action starts empty.
      app.compose(row.where === "" ? {} : { title: row.where });
      return;
    }
    navigate(row.to);
  };

  const onKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>): void => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelected(Math.min(rows.length - 1, selected + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelected(Math.max(0, selected - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const row = rows[selected];
      if (row !== undefined) run(row);
    }
  };

  return (
    <Sheet onClose={onClose} className="palette" label="Command palette">
      <input className="palette-field" autoFocus value={typed} placeholder="Do anything, go anywhere" aria-label="command"
        onChange={(e) => setTyped(e.target.value)} onKeyDown={onKeyDown} />
      <div className="palette-list" ref={list}>
        {sections.map((section, s) => {
          const before = sections.slice(0, s).reduce((n, earlier) => n + earlier.rows.length, 0);
          return (
            <div key={section.name ?? s} className="palette-group" role="group" aria-label={section.name ?? undefined}>
              {section.name !== null && <div className="kicker palette-kicker">{section.name}</div>}
              {section.rows.map((row, r) => {
                const i = before + r;
                return (
                  <button key={row.key} type="button" className={`palette-row${i === selected ? " on" : ""}`}
                    onMouseEnter={() => setSelected(i)} onClick={() => run(row)}>
                    <span className="palette-title"><Marked text={row.title} typed={typed} /></span>
                    {row.where !== "" && <span className="palette-where">{row.where}</span>}
                    {!app.phone && row.hint !== undefined && <kbd className="palette-hint">{row.hint}</kbd>}
                  </button>
                );
              })}
            </div>
          );
        })}
      </div>
    </Sheet>
  );
}
