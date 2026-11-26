import { ACCENTS, MAP_STYLES, SPACINGS, START_SCREENS, THEME_MODES, type AccentName, type MapStyle, type StartScreen, type Tree } from "@vemi/shared";
import { changeStartOn, useAppearance, useStartOn } from "../appearance.js";
import { paths } from "../api.js";
import { useResource } from "../state/resources.js";
import { chooseNewTaskVenture, useNewTaskVenture } from "./appContext.js";
import { useLevelWords } from "../levelNames.js";
import { Chip } from "./Chip.js";

const ACCENT_NAMES = Object.keys(ACCENTS) as AccentName[];
const THEME_WORDS = { light: "Light", dark: "Dark", system: "Match device" } as const;

const START_WORDS: Record<StartScreen, string> = { map: "Map", today: "Today" };
const STYLE_WORDS: Record<MapStyle, string> = { grid: "Grid", canvas: "Canvas" };

/** Account > Look and feel: accent, spacing, theme, Open on, Map style, and where new tasks go. Each applies as it is touched. */
export function AccountLook() {
  const { appearance, change } = useAppearance();
  const words = useLevelWords();
  const newTaskLabel = `New ${words.tasks.toLowerCase()} go to`;
  const lastUsed = `The ${words.space.toLowerCase()} I used last`;
  const { startOn } = useStartOn();
  const newTaskTo = useNewTaskVenture();
  const tree = useResource<Tree>(paths.tree);
  return (
    <div className="account-rows">
      <div className="account-row">
        <span className="account-row-title">Accent</span>
        <span className="swatches" role="group" aria-label="Accent">
          {ACCENT_NAMES.map((name) => (
            <button key={name} type="button" className="swatch" aria-label={name} aria-pressed={appearance.accent === name}
              style={{ background: ACCENTS[name].live }} onClick={() => change({ accent: name })} />
          ))}
        </span>
      </div>
      <div className="account-row">
        <span className="account-row-title">Spacing</span>
        <span className="choices seg" role="group" aria-label="Spacing">
          {SPACINGS.map((s) => (
            <Chip key={s} on={appearance.spacing === s}
              aria-pressed={appearance.spacing === s} onClick={() => change({ spacing: s })}>{s === "compact" ? "Compact" : "Comfortable"}</Chip>
          ))}
        </span>
      </div>
      <div className="account-row">
        <span className="account-row-title">Theme</span>
        <span className="choices seg" role="group" aria-label="Theme">
          {THEME_MODES.map((m) => (
            <Chip key={m} on={appearance.theme === m}
              aria-pressed={appearance.theme === m} onClick={() => change({ theme: m })}>{THEME_WORDS[m]}</Chip>
          ))}
        </span>
      </div>
      <div className="account-row">
        <span className="account-row-title">Open on</span>
        <span className="choices seg" role="group" aria-label="Open on">
          {START_SCREENS.map((s) => (
            <Chip key={s} on={startOn === s} aria-pressed={startOn === s} onClick={() => changeStartOn(s)}>{START_WORDS[s]}</Chip>
          ))}
        </span>
      </div>
      <div className="account-row">
        <span className="account-row-title">Map style</span>
        <span className="choices seg" role="group" aria-label="Map style">
          {MAP_STYLES.map((s) => (
            <Chip key={s} on={appearance.mapStyle === s} aria-pressed={appearance.mapStyle === s}
              onClick={() => change({ mapStyle: s })}>{STYLE_WORDS[s]}</Chip>
          ))}
        </span>
      </div>
      <div className="account-row">
        <span className="account-row-title">{newTaskLabel}</span>
        <span className="choices" role="group" aria-label={newTaskLabel}>
          <Chip on={newTaskTo === null} aria-pressed={newTaskTo === null}
            onClick={() => chooseNewTaskVenture(null)}>{lastUsed}</Chip>
          {(tree.data?.ventures ?? []).map((v) => (
            <Chip key={v.id} on={newTaskTo === v.id} aria-pressed={newTaskTo === v.id}
              onClick={() => chooseNewTaskVenture(v.id)}>{v.name}</Chip>
          ))}
        </span>
      </div>
    </div>
  );
}
