import { useEffect, useRef, useState } from "react";
import type { ArchivedItem, DeletePreview, Kind } from "@vemi/shared";
import { ApiError, api, isQueued, paths, read, removeForGood, type ArchivedAnswer } from "../api.js";
import { KEPT } from "../outcome.js";
import { archiveFind, archiveFound } from "../archiveFind.js";
import { archiveList, keptKinds, once, restoreSteps, waitingOn, waitingSaid } from "../archiveList.js";
import { counted } from "../bulkEdit.js";
import { age } from "../format.js";
import { alsoRemoved } from "../removal.js";
import { endedSession, useResource } from "../state/resources.js";
import { useLevelWords } from "../levelNames.js";
import type { LevelWords } from "../levelWords.js";
import { useApp } from "./appContext.js";
import { SurfaceKicker } from "./Chrome.js";
import { Chip } from "./Chip.js";
import { MoreMenu } from "./Menu.js";
import { Pending } from "./controls.js";
import { Sheet } from "./Sheet.js";
import { SelectionBar } from "./SelectionBar.js";
import { useSelection } from "./useSelection.js";

/** What each kind of thing is called on a row: the account's words for the four levels. */
const kindWords = (w: LevelWords): Record<Kind, string> => ({
  ventures: w.space.toLowerCase(),
  states: "state",
  stages: "lifecycle stage",
  projects: w.project.toLowerCase(),
  milestones: w.milestone.toLowerCase(),
  tasks: w.task.toLowerCase(),
  blockers: "blocker",
  notes: "note",
  decisions: "decision",
  risks: "risk",
  links: "link",
  tags: "tag",
});


/** A row is a kind and an id together: two tables can hand out the same id. */
const keyOf = (item: ArchivedItem): string => `${item.kind}:${item.id}`;

/**
 * Everything archived, newest first (VEMI-006). Out of the way, not gone: Restore brings it
 * back exactly as it was, and undo takes the restore back. Delete is the one door that
 * destroys anything, and decision 33 puts it here and nowhere else.
 *
 * A row says what kind of thing it is and when it went, where the handoff says where it came
 * from: the archive's answer does not carry the venture, and the API does not change.
 *
 * It can be searched and narrowed to kinds (VEMI-009), over the list already in memory, and
 * several rows restored at once: one call a row, in the order they are listed. Whether a
 * thing shows is read from its parents, so no order hides anything. Delete stays one row at
 * a time with the name typed, and that is the point of it.
 */
export function ArchiveView() {
  const app = useApp();
  const w = useLevelWords();
  const KIND_WORDS = kindWords(w);
  const archived = useResource<ArchivedAnswer>(paths.archived);
  const [deleting, setDeleting] = useState<{ readonly kind: Kind; readonly id: string; readonly label: string } | null>(null);
  // Opened from a search that found nothing, the field already holds what was searched for.
  const [typed, setTyped] = useState(archiveFind);
  useEffect(() => archiveFound(), []);
  const [kinds, setKinds] = useState<ReadonlySet<Kind>>(new Set());
  const chooser = useSelection();
  // A restore in flight: the bar's Restore is off until it lands, so a second press cannot
  // start another pass over the same rows. The ref closes the gap before the re-render.
  const [restoring, setRestoring] = useState(false);
  const inFlight = useRef(false);
  const held = archived.data?.items;
  // A kind the archive no longer holds is let go of, so an undo that brings one of its rows
  // back does not quietly narrow the list to it again.
  useEffect(() => {
    if (held !== undefined) setKinds((current) => keptKinds(held, current));
  }, [held]);
  if (archived.data === null) return <Pending error={archived.error} onRetry={archived.refetch} />;

  const all = archived.data.items;
  const view = archiveList(all, { typed, kinds });
  const offered = new Set(view.kinds.map((k) => k.kind));
  /** Nothing chosen means every kind, and the chip for that says so. */
  const everything = ![...kinds].some((kind) => offered.has(kind));
  const matched = view.kinds.reduce((n, k) => n + k.of, 0);
  const narrowed = typed.trim() !== "" || !everything;
  const order = view.shown.map(keyOf);
  const picked = view.shown.filter((item) => chooser.has(keyOf(item)));

  const toggleKind = (kind: Kind): void => setKinds((current) => {
    const next = new Set(current);
    if (next.has(kind)) next.delete(kind);
    else next.add(kind);
    return next;
  });

  /**
   * The row's own restore, once a row, and one step to undo the lot. A row the Worker refuses
   * — a tag whose word another tag has taken since — is named in the notice and stays in the
   * archive; the rest still come back, and the undo covers only those.
   */
  const restoreSelected = (): void => {
    const chosen = picked;
    if (chosen.length === 0 || inFlight.current) return;
    inFlight.current = true;
    setRestoring(true);
    const back: ArchivedItem[] = [];
    const answers: { readonly item: ArchivedItem; readonly record: unknown }[] = [];
    const refused: string[] = [];
    // Undo archives them again in the order they first went, not the order listed: see restoreSteps.
    const steps = restoreSteps(back, {
      archive: (item) => api.archive(item.kind, item.id),
      unarchive: (item) => api.unarchive(item.kind, item.id),
    });
    void app.act(async () => {
      let waiting = false;
      for (const item of chosen) {
        try {
          const answer = await api.unarchive(item.kind, item.id);
          if (isQueued(answer)) waiting = true;
          else answers.push({ item, record: answer });
          back.push(item);
        } catch (e) {
          // The session is over for every one of them: act signs the device out once.
          if (e instanceof ApiError && e.status === 401) throw e;
          const why = e instanceof Error ? e.message : "it could not be restored";
          refused.push(why.includes(item.label) ? why : `${item.label}: ${why}`);
        }
      }
      if (back.length === 0) throw new Error(refused.join(". "));
      return waiting ? { queued: true } : back;
    }, {
      // Read after the loop: the step is put on the stack only once it is done, naming what came back.
      get what() { return `restored ${counted(back.length, "thing")}`; },
      // Read after the loop too: restoreSteps orders `back` when the step runs, not now.
      undo: () => steps.undo(),
      redo: () => steps.redo(),
    }).then((ok) => {
      inFlight.current = false;
      setRestoring(false);
      if (!ok) return;
      chooser.stop();
      // Kept, the notice already says so; a count restored over it would say they landed.
      // What was refused is still news, so it is said with the kept sentence beside it.
      if (ok === "kept") {
        if (refused.length > 0) app.notify(`${KEPT} Not restored: ${refused.join(". ")}`);
        return;
      }
      // A parent restored in this same pass is not one to wait for.
      const came = new Set(back.map(keyOf));
      const still = all.filter((item) => !came.has(keyOf(item)));
      const waits = waitingSaid(answers.map(({ item, record }) => ({ label: item.label, on: waitingOn(record, still) })));
      const said = [`${counted(back.length, "thing")} restored.`];
      if (waits !== "") said.push(waits);
      if (refused.length > 0) said.push(`Not restored: ${refused.join(". ")}`);
      app.notify(said.join(" "), { undo: true });
    });
  };

  const said = view.of === 0 ? "Nothing archived."
    : narrowed ? `${view.shown.length} of ${view.of}`
    : `${view.of} archived`;

  const restore = (kind: Kind, id: string, label: string): void => {
    let answer: unknown = null;
    void app.act(async () => (answer = await api.unarchive(kind, id)), {
      what: `restored ${label}`,
      undo: () => api.archive(kind, id),
      redo: () => api.unarchive(kind, id),
    }).then((ok) => {
      if (ok !== "sent") return;
      // Out of the archive but under a parent still in it, it shows nowhere yet: say so.
      const on = waitingOn(answer, all);
      app.notify(on.length === 0 ? `${label} restored` : `${label} is back, and shows ${once(on)}.`, { undo: true });
    });
  };

  return (
    <div className="archive">
      <SurfaceKicker menu={<MoreMenu label="archive" items={app.phoneMenu} />}>Archive</SurfaceKicker>
      {view.of > 0 && (
        <input className="big-field search-field" value={typed} placeholder="Search the archive"
          aria-label="search the archive" onChange={(e) => setTyped(e.target.value)} />
      )}
      <p className="archive-said" role="status">{said}</p>
      {view.of > 0 && (
        <div className="archive-tools">
          {view.kinds.length > 1 && (
            <div className="chips" role="group" aria-label="kinds">
              <Chip on={everything} aria-pressed={everything}
                onClick={() => setKinds(new Set())}>
                Every kind <span className="chip-count">{matched}</span>
              </Chip>
              {view.kinds.map(({ kind, of }) => (
                <Chip key={kind} on={kinds.has(kind)} aria-pressed={kinds.has(kind)}
                  onClick={() => toggleKind(kind)}>
                  {KIND_WORDS[kind]} <span className="chip-count">{of}</span>
                </Chip>
              ))}
            </div>
          )}
          {/* Decision 9. A switch you can see, not a modifier you have to know. */}
          <button type="button" className={`word-button${chooser.on ? " on" : ""}`} aria-pressed={chooser.on}
            onClick={() => chooser.setOn(!chooser.on)}>Select</button>
        </div>
      )}
      <div className="archive-rows">
        {view.of === 0 && <div className="rows-empty">Nothing archived. {`Archive a ${w.task.toLowerCase()}, ${w.project.toLowerCase()}, ${w.space.toLowerCase()} or note and it waits here until you restore it or delete it for good.`}</div>}
        {view.of > 0 && matched === 0 && (
          <div className="rows-empty">Nothing archived matches “{typed.trim()}”. Try fewer letters, or clear the field to see everything.</div>
        )}
        {matched > 0 && view.shown.length === 0 && (
          <div className="rows-empty">Nothing of the kinds chosen matches. Choose Every kind, or another kind above.</div>
        )}
        {view.shown.map((item) => {
          const key = keyOf(item);
          return (
            <div key={key} className={`archive-row${chooser.has(key) ? " selected" : ""}`}>
              {chooser.on ? (
                <button type="button" className="archive-title archive-pick" aria-pressed={chooser.has(key)}
                  onClick={(e) => chooser.toggle(key, order, e.shiftKey)}>{item.label}</button>
              ) : (
                <span className="archive-title">{item.label}</span>
              )}
              <span className="archive-where">{KIND_WORDS[item.kind]} · {age(item.archivedAt)}</span>
              <button type="button" className="row-action" onClick={() => restore(item.kind, item.id, item.label)}>Restore</button>
              <button type="button" className="row-action quiet"
                onClick={() => setDeleting({ kind: item.kind, id: item.id, label: item.label })}>Delete…</button>
            </div>
          );
        })}
      </div>
      {chooser.on && picked.length > 0 && (
        <SelectionBar what={`${picked.length} selected`} onClear={chooser.stop}>
          <button type="button" className="bar-action" disabled={restoring} onClick={restoreSelected}>Restore</button>
        </SelectionBar>
      )}
      {deleting !== null && (
        <DeleteSheet what={deleting} onClose={() => setDeleting(null)} onDone={() => { setDeleting(null); archived.refetch(); }} />
      )}
    </div>
  );
}

/**
 * The second, deliberate act. It says what goes with the record, counted from the database
 * rather than guessed, and it asks for the record's own name — not a second click in the
 * same place as the first, because not knowing what a control will do is the fault this
 * rework exists to fix.
 */
function DeleteSheet({ what, onClose, onDone }: {
  readonly what: { readonly kind: Kind; readonly id: string; readonly label: string };
  readonly onClose: () => void;
  readonly onDone: () => void;
}) {
  const app = useApp();
  const [preview, setPreview] = useState<DeletePreview | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [typed, setTyped] = useState("");
  const [working, setWorking] = useState(false);

  useEffect(() => {
    let live = true;
    void read<DeletePreview>(paths.deletePreview(what.kind, what.id))
      .then((answer) => { if (live) setPreview(answer.data); })
      .catch((e: unknown) => { if (live && !endedSession(e)) setFailed(e instanceof Error ? e.message : "That could not be read."); });
    return () => { live = false; };
  }, [what.kind, what.id]);

  const also = preview === null ? [] : alsoRemoved(preview.kind, preview.removes);
  const ready = preview !== null && preview.refusal === null && typed.trim() === preview.confirm;

  const go = (): void => {
    if (!ready || preview === null || working) return;
    setWorking(true);
    setFailed(null);
    void removeForGood(what.kind, what.id, typed.trim()).then(
      () => {
        app.notify(`Deleted ${preview.label}. It is not in the archive any more.`);
        onDone();
      },
      (e: unknown) => {
        setWorking(false);
        if (!endedSession(e)) setFailed(e instanceof Error ? e.message : "That could not be deleted.");
      },
    );
  };

  return (
    <Sheet onClose={onClose} placement="centre" label="delete for good">
      <div className="sheet-head">
        <span className="label">Delete for good</span>
        <span className="fill" />
        <button type="button" className="close-button" aria-label="close" onClick={onClose}>×</button>
      </div>

      {/* Its own scroll: with the keyboard up on a phone, a long list of what goes with it
          would otherwise leave the buttons out of reach. */}
      <div className="sheet-body sheet-section">
        <div className="delete-title">Delete “{what.label}” for good?</div>

        {preview === null && failed === null && <div className="empty">Counting what goes with it…</div>}

        {preview !== null && preview.refusal !== null && (
          <>
            <div className="delete-refusal">{preview.refusal}</div>
            <div className="sheet-actions">
              <button type="button" className="quiet-button" onClick={onClose}>Close</button>
            </div>
          </>
        )}

        {preview !== null && preview.refusal === null && (
          <>
            {also.length > 0 ? (
              <>
                <div className="delete-lede">This also deletes:</div>
                <ul className="delete-list">{also.map((line) => <li key={line}>{line}</li>)}</ul>
              </>
            ) : (
              <div className="delete-lede">Nothing else goes with it.</div>
            )}
            <div className="delete-warning">This cannot be undone.</div>

            <label className="delete-confirm">
              <span className="label">Type {preview.confirm} to confirm</span>
              <input
                className="field"
                autoFocus
                value={typed}
                aria-label={`type ${preview.confirm} to confirm`}
                placeholder={preview.confirm}
                onChange={(e) => setTyped(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key !== "Enter") return;
                  e.preventDefault();
                  go();
                }}
              />
            </label>

            {failed !== null && <div className="delete-failed" role="status">{failed}</div>}

            <div className="sheet-actions">
              <button type="button" className="quiet-button" onClick={onClose}>Cancel</button>
              <button type="button" className="primary-button" disabled={!ready || working} onClick={go}>
                {working ? "Deleting…" : "Delete for good"}
              </button>
            </div>
          </>
        )}

        {preview === null && failed !== null && (
          <>
            <div className="delete-failed" role="status">{failed}</div>
            <div className="sheet-actions">
              <button type="button" className="quiet-button" onClick={onClose}>Close</button>
            </div>
          </>
        )}
      </div>
    </Sheet>
  );
}
