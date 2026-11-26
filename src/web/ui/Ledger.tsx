import { useState } from "react";
import type { Decision, Risk } from "@vemi/shared";
import { api, createOnce, paths } from "../api.js";
import { shortDate } from "../format.js";
import { reorder } from "../order.js";
import { useResource } from "../state/resources.js";
import { byPosition, nextPosition } from "../treeIndex.js";
import { useApp } from "./appContext.js";
import { AddLine, EditableText } from "./controls.js";
import { OrderedRows } from "./OrderedRows.js";
import { DatePick } from "./Picker.js";

type Owner = { readonly ventureId: string } | { readonly projectId: string };
type Entry = Decision | Risk;

/** What differs between the two kinds; the rest of the section is the same. */
const KINDS = {
  decisions: { kicker: "Decisions", one: "decision", empty: "No decisions.", add: "a decision", dated: "decided", field: "decidedOn" },
  risks: { kicker: "Risks", one: "risk", empty: "No risks.", add: "a risk", dated: "raised", field: "raisedOn" },
} as const;

const dateOf = (kind: keyof typeof KINDS, e: Entry): string | null =>
  kind === "decisions" ? (e as Decision).decidedOn : (e as Risk).raisedOn;

/**
 * Decisions and risks on a venture or a project: what was settled and what is watched.
 * Recorded, never worked: no status, nothing counted. A venture's page shows the ones on the
 * venture itself, so a project's stay on its own page.
 */
export function Ledger(owner: Owner) {
  return (
    <div id="ledger" className="ledger">
      <Section kind="decisions" owner={owner} />
      <Section kind="risks" owner={owner} />
    </div>
  );
}

function Section({ kind, owner }: { readonly kind: keyof typeof KINDS; readonly owner: Owner }) {
  const app = useApp();
  const words = KINDS[kind];
  const filter: Record<string, string> = "ventureId" in owner ? { venture: owner.ventureId } : { project: owner.projectId };
  const list = useResource<Entry[]>(paths.list(kind, filter));
  // A move waits for the answer that shows the last one.
  const [movedWith, setMovedWith] = useState<Entry[] | null>(null);
  const waiting = movedWith !== null && movedWith === list.data;
  const items = (list.data ?? []).filter((e) => !("ventureId" in owner) || e.ventureId !== null).sort(byPosition);

  const move = (id: string, to: number): void => {
    const placements = reorder(items, id, to);
    if (placements.length === 0 || waiting) return;
    const back = placements.map((pl) => ({ id: pl.id, position: items.find((i) => i.id === pl.id)?.position ?? pl.position }));
    setMovedWith(list.data);
    void app.act(() => api.place(kind, placements), {
      what: `moved the ${words.one}`,
      undo: () => api.place(kind, back),
      redo: () => api.place(kind, placements),
    }).then((ok) => {
      if (!ok) setMovedWith(null);
    });
  };

  return (
    <section className="about-block">
      <div className="kicker more-kicker">{words.kicker}</div>
      {items.length === 0 && <div className="more-empty">{words.empty}</div>}
      <OrderedRows items={items} className="more-row" label={(e) => e.title} move={move}
        row={(e, grip) => {
          const on = dateOf(kind, e);
          return (
            <div>
              <div className="more-line">
                {grip}
                <EditableText value={e.title} placeholder={words.one}
                  onSave={(title, was) => app.edit(kind, e.id, { title }, { title: was }, `renamed the ${words.one}`)} />
                <span className="more-note">{words.dated}{on !== null && ` ${shortDate(on, app.today)}`}</span>
                <DatePick compact value={on} label={words.dated}
                  onSave={(next) => void app.edit(kind, e.id, { [words.field]: next }, e, `changed the date of the ${words.one}`)} />
                <button type="button" className="close-button" aria-label={`archive ${words.one}`}
                  onClick={() => void app.archive(kind, e.id, words.one)}>×</button>
              </div>
              <div className="about-goal">
                <EditableText multiline allowEmpty value={e.body} placeholder="Why, and what it rests on."
                  onSave={(body, was) => app.edit(kind, e.id, { body }, { body: was }, `edited the ${words.one}`)} />
              </div>
            </div>
          );
        }} />
      <AddLine placeholder={words.add} label={`Add ${words.one}`}
        onAdd={(title) => app.act(createOnce(kind, {
          ...owner, title, position: nextPosition(items), ...(app.today === null ? {} : { [words.field]: app.today }),
        }))} />
    </section>
  );
}
