import { useEffect, useState } from "react";
import { paths, pushTest, read, saveReminders, type ReminderChoices } from "../api.js";
import { isLocal } from "../local/mode.js";
import { browserNow, callsNow, deviceState, turnOff, turnOn, type DeviceState } from "../pushDevice.js";
import { install, IOS_STEPS, useInstallOffer } from "../installPrompt.js";
import "./accountReminders.css";
import { useApp } from "./appContext.js";
import { useLevelWords } from "../levelNames.js";
import { Chip } from "./Chip.js";
import { Status, Switch } from "./Switch.js";

export const MORNINGS = [["Off", null], ["6:30 am", "06:30"], ["7:00 am", "07:00"], ["8:00 am", "08:00"]] as const;
export const QUIETS = [
  ["9 pm to 7 am", "21:00", "07:00"],
  ["10 pm to 6 am", "22:00", "06:00"],
  ["None", null, null],
] as const;
const NOTHING_ON: ReminderChoices = { morningAt: null, taskReminders: false, quietFrom: null, quietTo: null };

/** The device's own words, where the browser or the phone leaves nothing to press. */
export const DEVICE_NOTE: Readonly<Record<DeviceState, string>> = {
  on: "This browser will show reminders even when VEMI is closed.",
  off: "",
  denied: "This browser has blocked reminders. Allow them in its site settings, then try again.",
  install: IOS_STEPS,
  unsupported: "This browser cannot show reminders.",
};

/** What stands in place of the push controls in a copy kept in the page. */
export const LOCAL_REMINDERS_LINE = "Reminders show inside VEMI while it is open.";

/** Reminders: this device, then what the account gets. Every control saves as it is touched. */
export function AccountReminders({ local = isLocal() }: { readonly local?: boolean } = {}) {
  const words = useLevelWords();
  const onTasks = `Reminders on ${words.tasks.toLowerCase()}`;
  const onlyFor = `Only on ${words.tasks.toLowerCase()} you set a reminder for.`;
  const app = useApp();
  const offer = useInstallOffer();
  const [choices, setChoices] = useState<ReminderChoices>(NOTHING_ON);
  const [device, setDevice] = useState<DeviceState | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    read<Partial<ReminderChoices>>(paths.appearance)
      .then((r) => {
        if (live) setChoices({
          morningAt: r.data.morningAt ?? null,
          taskReminders: r.data.taskReminders === true,
          quietFrom: r.data.quietFrom ?? null,
          quietTo: r.data.quietTo ?? null,
        });
      })
      .catch(() => undefined);
    // A copy in the page has no push service: it never asks the browser for anything.
    if (!local) deviceState(browserNow()).then((s) => { if (live) setDevice(s); }).catch(() => { if (live) setDevice("unsupported"); });
    return () => { live = false; };
  }, [local]);

  const save = (change: Partial<ReminderChoices>): void => {
    setChoices((was) => ({ ...was, ...change }));
    setProblem(null);
    saveReminders(change).catch((e: unknown) => setProblem(e instanceof Error ? e.message : "That did not save."));
  };
  const act = async (work: () => Promise<void>): Promise<void> => {
    setBusy(true);
    setProblem(null);
    try {
      await work();
    } catch (e) {
      setProblem(e instanceof Error ? e.message : "That did not work.");
    } finally {
      setBusy(false);
    }
  };
  const on = () => act(async () => setDevice(await turnOn(browserNow(), callsNow)));
  const off = () => act(async () => { await turnOff(browserNow(), callsNow); setDevice("off"); });
  const test = () => act(async () => {
    const sent = await pushTest();
    app.notify(sent.sent > 0 ? "Test reminder sent." : "No device answered.");
  });

  const quiet = choices.quietFrom !== null && choices.quietTo !== null;
  return (
    <div className="reminders">
      <div className="account-rows">
        {local ? (
          <div className="account-row">
            <span className="account-row-title">{LOCAL_REMINDERS_LINE}</span>
          </div>
        ) : (
          <div className="account-row">
            <span className="account-row-title">
              <Status kind={device === "on" ? "on" : "off"}>{device === "on" ? "Reminders are on here" : "Reminders are off here"}</Status>
              {device !== null && DEVICE_NOTE[device] !== "" && <span className="account-row-note">{DEVICE_NOTE[device]}</span>}
            </span>
            {device === "on" && (
              <span className="account-row-actions">
                <button type="button" className="row-action" disabled={busy} onClick={() => void test()}>Send a test</button>
                <button type="button" className="row-action quiet" disabled={busy} onClick={() => void off()}>Turn off</button>
              </span>
            )}
            {(device === "off" || device === "denied") && (
              <button type="button" className="row-action" disabled={busy} onClick={() => void on()}>Turn on</button>
            )}
          </div>
        )}
        {problem !== null && <span className="account-row-note failed" role="alert">{problem}</span>}
        {!local && offer !== null && !(offer === "ios" && device === "install") && (
          <div className="account-row">
            <span className="account-row-title">
              Add to home screen
              <span className="account-row-note">{offer === "ios" ? IOS_STEPS : "Reminders reach an installed copy most reliably."}</span>
            </span>
            {offer === "button" && <button type="button" className="row-action" onClick={() => void install()}>Install</button>}
          </div>
        )}
        <div className="account-row">
          <span className="account-row-title">
            Morning summary
            <span className="account-row-note">What is on today, once a day.</span>
          </span>
          <span className="choices" role="group" aria-label="Morning summary">
            <span className="seg">
              {MORNINGS.map(([word, at]) => (
                <Chip key={word} on={choices.morningAt === at} aria-pressed={choices.morningAt === at}
                  onClick={() => save({ morningAt: at })}>{word}</Chip>
              ))}
            </span>
            {choices.morningAt !== null && (
              <input className="field reminders-time" type="time" aria-label="Morning summary time"
                value={choices.morningAt} onChange={(e) => { if (e.target.value !== "") save({ morningAt: e.target.value }); }} />
            )}
          </span>
        </div>
        <div className="account-row">
          <span className="account-row-title">
            {onTasks}
            <span className="account-row-note">{onlyFor}</span>
          </span>
          <Switch on={choices.taskReminders} label={onTasks} onChange={(next) => save({ taskReminders: next })} />
        </div>
        <div className="account-row">
          <span className="account-row-title">
            Quiet hours
            <span className="account-row-note">Nothing comes through between these times.</span>
          </span>
          <span className="choices" role="group" aria-label="Quiet hours">
            <span className="seg">
              {QUIETS.map(([word, from, to]) => {
                const chosen = choices.quietFrom === from && choices.quietTo === to;
                return (
                  <Chip key={word} on={chosen} aria-pressed={chosen}
                    onClick={() => save({ quietFrom: from, quietTo: to })}>{word}</Chip>
                );
              })}
            </span>
            {quiet && (
              <>
                <input className="field reminders-time" type="time" aria-label="Quiet hours start"
                  value={choices.quietFrom ?? ""} onChange={(e) => { if (e.target.value !== "") save({ quietFrom: e.target.value }); }} />
                <input className="field reminders-time" type="time" aria-label="Quiet hours end"
                  value={choices.quietTo ?? ""} onChange={(e) => { if (e.target.value !== "") save({ quietTo: e.target.value }); }} />
              </>
            )}
          </span>
        </div>
      </div>
    </div>
  );
}
