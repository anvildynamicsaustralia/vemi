import { changeFirstRunStep } from "../firstRunState.js";
import { changeLevelNames, currentNames } from "../levelNames.js";
import { LEVEL_PRESETS } from "../levelPresets.js";
import { pluralOf, type LevelNames } from "../levelWords.js";
import { useApp } from "./appContext.js";
import "./firstRun.css";

/** A preset's first three levels as plural words, "Ventures, projects, milestones". */
export const presetWords = (names: LevelNames): string =>
  [pluralOf(names.space), pluralOf(names.project).toLowerCase(), pluralOf(names.milestone).toLowerCase()].join(", ");

/**
 * Step 1, in the map's place: what VEMI is for. A card sets the four level names, with the undo
 * notice, and goes on to step 2. "Skip for now" keeps the names as they are and goes on.
 */
export function FirstRunUse() {
  const app = useApp();

  const choose = (label: string, next: LevelNames): void => {
    const before = currentNames();
    void app.act(
      () => { changeLevelNames(next); return Promise.resolve(); },
      {
        what: "renamed the levels",
        undo: () => { changeLevelNames(before); return Promise.resolve(); },
        redo: () => { changeLevelNames(next); return Promise.resolve(); },
      },
    ).then((outcome) => {
      if (outcome === false) return;
      app.notify(`Names changed to ${label}.`, { undo: true });
      changeFirstRunStep(2);
    });
  };

  return (
    <div className="first-run-use">
      <div className="kicker">Welcome to VEMI</div>
      <h2>What are you using VEMI for?</h2>
      <div className="first-run-presets">
        {LEVEL_PRESETS.map((p) => (
          <button key={p.label} type="button" className="first-run-preset" onClick={() => choose(p.label, p.names)}>
            <b>{p.label}</b>
            <small>{presetWords(p.names)}</small>
          </button>
        ))}
      </div>
      <button type="button" className="first-run-skip-now" onClick={() => changeFirstRunStep(2)}>Skip for now</button>
    </div>
  );
}
