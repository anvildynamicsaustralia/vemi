import { useState } from "react";
import { Icon } from "@vemi/icons";
import { saveReminders, type ReminderChoices } from "../api.js";
import { useLevelWords } from "../levelNames.js";
import { isLocal } from "../local/mode.js";
import { browserNow, callsNow, deviceState, turnOn, type DeviceState, type PushBrowser, type PushCalls } from "../pushDevice.js";
import { DEVICE_NOTE, MORNINGS, QUIETS } from "./AccountReminders.js";
import { useApp } from "./appContext.js";
import { Chip } from "./Chip.js";
import { Switch } from "./Switch.js";
import "./firstRun.css";

/** The mock's starting choices: 7:00 am, On, 9 pm to 7 am. Nothing is saved until Turn on. */
export const REMIND_DEFAULTS: ReminderChoices = { morningAt: "07:00", taskReminders: true, quietFrom: "21:00", quietTo: "07:00" };

/**
 * Turn on: the account's choices are saved first, then this device is asked. A device that
 * cannot take reminders (install, unsupported, denied) leaves the account's choices as saved.
 */
export async function remindTurnOn(
  choices: ReminderChoices,
  save: (change: ReminderChoices) => Promise<unknown>,
  browser: PushBrowser,
  calls: PushCalls,
  local = false,
): Promise<DeviceState> {
  await save(choices);
  // A copy in the page shows its reminders inside itself: there is no device to ask.
  if (local) return "on";
  // A device that has nothing to press (an iPhone in Safari, a browser without push) is told so,
  // not asked; one already on stays on.
  const now = await deviceState(browser);
  if (now === "install" || now === "unsupported" || now === "on") return now;
  return turnOn(browser, calls);
}

/**
 * Step 6, on Today above the list: the reminder card. Turn on saves the choices and asks this
 * device. Not now saves nothing, so every reminder stays off. Either goes on through `onDone`.
 */
export function FirstRunRemind({ onDone }: { readonly onDone: () => void }) {
  const app = useApp();
  const words = useLevelWords();
  const onTasks = `Reminders on ${words.tasks.toLowerCase()}`;
  const [choices, setChoices] = useState<ReminderChoices>(REMIND_DEFAULTS);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [device, setDevice] = useState<DeviceState | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const change = (next: Partial<ReminderChoices>): void => setChoices((was) => ({ ...was, ...next }));

  const turnOnNow = async (): Promise<void> => {
    setBusy(true);
    setProblem(null);
    try {
      const state = await remindTurnOn(choices, saveReminders, browserNow(), callsNow, isLocal());
      setSaved(true);
      setDevice(state);
      if (state === "on") {
        app.notify("Reminders on.");
        onDone();
      }
    } catch (e) {
      setProblem(e instanceof Error ? e.message : "That did not work.");
    } finally {
      setBusy(false);
    }
  };

  const notNow = (): void => {
    if (!saved) app.notify("No reminders.");
    onDone();
  };

  const note = device === null ? "" : DEVICE_NOTE[device];
  return (
    <section className="first-run-card" aria-label="Reminders">
      <span className="first-run-card-icon"><Icon name="lucide:bell" size={20} /></span>
      <h4>Want VEMI to remind you?</h4>
      <div className="first-run-row">
        <span>Morning summary</span>
        <span className="choices seg" role="group" aria-label="Morning summary">
          {MORNINGS.map(([word, at]) => (
            <Chip key={word} on={choices.morningAt === at} aria-pressed={choices.morningAt === at}
              onClick={() => change({ morningAt: at })}>{word}</Chip>
          ))}
        </span>
      </div>
      <div className="first-run-row">
        <span>{onTasks}</span>
        <Switch on={choices.taskReminders} label={onTasks} onChange={(next) => change({ taskReminders: next })} />
      </div>
      <div className="first-run-row">
        <span>Quiet hours</span>
        <span className="choices seg" role="group" aria-label="Quiet hours">
          {QUIETS.map(([word, from, to]) => {
            const chosen = choices.quietFrom === from && choices.quietTo === to;
            return (
              <Chip key={word} on={chosen} aria-pressed={chosen} onClick={() => change({ quietFrom: from, quietTo: to })}>{word}</Chip>
            );
          })}
        </span>
      </div>
      {note !== "" && <p className="first-run-note" role="status">{note}</p>}
      {problem !== null && <p className="first-run-note failed" role="alert">{problem}</p>}
      <div className="first-run-buttons">
        <button type="button" className="first-run-action" disabled={busy} onClick={() => void turnOnNow()}>Turn on</button>
        <button type="button" className="first-run-skip-now" disabled={busy} onClick={notNow}>{saved ? "Continue" : "Not now"}</button>
      </div>
    </section>
  );
}
