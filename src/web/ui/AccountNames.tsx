import { useEffect, useState } from "react";
import { DEFAULT_NEW_STAGES, type StageKind } from "@vemi/shared";
import { paths, read, saveDefaultStages, saveLevelNames } from "../api.js";
import { currentNames, setLevelNames, useLevelWords } from "../levelNames.js";
import { LEVEL_PRESETS, examplePath, presetOf } from "../levelPresets.js";
import { DEFAULT_LEVEL_NAMES, type LevelNames } from "../levelWords.js";
import "./accountNames.css";
import { useApp } from "./appContext.js";
import { Chip } from "./Chip.js";

type Stage = { readonly name: string; readonly kind: StageKind };
const LEVELS = ["space", "project", "milestone", "task"] as const;
const LABELS: Readonly<Record<(typeof LEVELS)[number], string>> = {
  space: "Top level", project: "Inside it", milestone: "Checkpoints", task: "Things to do",
};

const KIND_WORD: Readonly<Record<StageKind, string>> = {
  early: "Early", active: "Active", paused: "Paused", shipped: "Shipped", stopped: "Stopped",
};

/** What goes to the account for a set of names: a level at its shipped word is sent as null. */
const toChange = (n: LevelNames): Record<string, string | null> =>
  Object.fromEntries(LEVELS.map((l) => [l, n[l] === DEFAULT_LEVEL_NAMES[l] ? null : n[l]]));

const sameStages = (a: readonly Stage[], b: readonly Stage[]): boolean =>
  a.length === b.length && a.every((s, i) => s.name === b[i]?.name && s.kind === b[i]?.kind);

/** Account > Names: the four level names, a path that shows them, and the stages a new space starts with. */
export function AccountNames() {
  const app = useApp();
  const words = useLevelWords();
  const names: LevelNames = { space: words.space, project: words.project, milestone: words.milestone, task: words.task };
  const [draft, setDraft] = useState<Partial<LevelNames>>({});
  const [stages, setStages] = useState<readonly Stage[]>(DEFAULT_NEW_STAGES);
  const [stageDraft, setStageDraft] = useState<Readonly<Record<number, string>>>({});
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    read<{ defaultStages?: readonly Stage[] | null }>(paths.appearance)
      .then((r) => { if (live && r.data.defaultStages) setStages(r.data.defaultStages); })
      .catch(() => undefined);
    return () => { live = false; };
  }, []);

  const showNames = (n: LevelNames): Promise<unknown> => {
    setLevelNames(n);
    setDraft({});
    return saveLevelNames(toChange(n));
  };

  /** Applies names at once, saves them, and puts the way back on the undo notice. */
  const chooseNames = (next: LevelNames, said: string): void => {
    const before = currentNames();
    if (LEVELS.every((l) => before[l] === next[l])) return;
    setProblem(null);
    setLevelNames(next);
    setDraft({});
    void app.act(() => saveLevelNames(toChange(next)), {
      what: "renamed the levels",
      undo: () => showNames(before),
      redo: () => showNames(next),
    }).then((outcome) => { if (outcome !== false) app.notify(said, { undo: true }); });
  };

  const commitName = (level: (typeof LEVELS)[number]): void => {
    const typed = draft[level];
    if (typed === undefined) return;
    const text = typed.trim();
    if (text === "") { setDraft({}); setProblem("A name cannot be empty."); return; }
    chooseNames({ ...names, [level]: text }, "Names changed.");
  };

  const chooseStages = (next: readonly Stage[]): void => {
    const before = stages;
    if (sameStages(before, next)) return;
    setStages(next);
    setStageDraft({});
    const send = (list: readonly Stage[]): Promise<unknown> =>
      saveDefaultStages(sameStages(list, DEFAULT_NEW_STAGES) ? null : list);
    void app.act(() => send(next), {
      what: "changed the starting stages",
      undo: () => { setStages(before); return send(before); },
      redo: () => { setStages(next); return send(next); },
    }).then((outcome) => { if (outcome !== false) app.notify("Starting stages changed.", { undo: true }); });
  };

  const commitStage = (i: number): void => {
    const typed = stageDraft[i];
    if (typed === undefined) return;
    const text = typed.trim();
    const was = stages[i];
    if (was === undefined) return;
    if (text === "") { setStageDraft({}); setProblem("A stage needs a name."); return; }
    setProblem(null);
    chooseStages(stages.map((s, n) => (n === i ? { ...s, name: text } : s)));
  };

  const matched = presetOf(names);
  const namesAreShipped = LEVELS.every((l) => names[l] === DEFAULT_LEVEL_NAMES[l]);
  const stagesAreShipped = sameStages(stages, DEFAULT_NEW_STAGES);
  return (
    <div className="names">
      <section className="names-block" aria-labelledby="names-words">
        <div className="names-block-head">
          <h3 className="names-heading" id="names-words">Level names</h3>
          <button type="button" className="names-reset" disabled={namesAreShipped}
            onClick={() => chooseNames(DEFAULT_LEVEL_NAMES, "Names put back.")}>Put back</button>
        </div>
        <span className="choices seg" role="group" aria-label="Start from">
          {LEVEL_PRESETS.map((p) => (
            <Chip key={p.label} on={matched === p.label} aria-pressed={matched === p.label}
              onClick={() => chooseNames(p.names, `Names changed to ${p.label}.`)}>{p.label}</Chip>
          ))}
        </span>
        <div className="names-list">
          {LEVELS.map((level, i) => (
            <label key={level} className="names-field">
              <span className="names-step" aria-hidden="true">{i + 1}</span>
              <span className="names-label">{LABELS[level]}</span>
              <input value={draft[level] ?? names[level]} maxLength={30} aria-label={LABELS[level]}
                placeholder={DEFAULT_LEVEL_NAMES[level]}
                onChange={(e) => setDraft({ ...draft, [level]: e.target.value })}
                onBlur={() => commitName(level)}
                onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }} />
              <span className="names-was">{names[level] === DEFAULT_LEVEL_NAMES[level] ? "Shipped word" : `Was ${DEFAULT_LEVEL_NAMES[level]}`}</span>
            </label>
          ))}
        </div>
      </section>
      <section className="names-block" aria-label="Example">
        <h3 className="names-heading">How it reads</h3>
        <ol className="names-path">
          {examplePath(names).map((step, i) => (
            <li key={step.word + String(i)}>
              {i > 0 && <i aria-hidden="true">›</i>}
              <small>{step.word}</small>
              <b>{step.example}</b>
            </li>
          ))}
        </ol>
      </section>
      <section className="names-block" aria-labelledby="names-stages">
        <div className="names-block-head">
          <h3 className="names-heading" id="names-stages">Starting stages</h3>
          <button type="button" className="names-reset" disabled={stagesAreShipped}
            onClick={() => chooseStages(DEFAULT_NEW_STAGES)}>Put back</button>
        </div>
        <div className="names-list">
          {stages.map((s, i) => (
            <label key={i} className="names-field">
              <span className="names-step" aria-hidden="true">{i + 1}</span>
              <span className="names-label">Stage {i + 1}</span>
              <input value={stageDraft[i] ?? s.name} maxLength={60} aria-label={`Stage ${i + 1}`}
                onChange={(e) => setStageDraft({ ...stageDraft, [i]: e.target.value })}
                onBlur={() => commitStage(i)}
                onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }} />
              <span className="names-was">{KIND_WORD[s.kind]}</span>
            </label>
          ))}
        </div>
      </section>
      {problem !== null && <p className="account-row-note" role="alert">{problem}</p>}
    </div>
  );
}
