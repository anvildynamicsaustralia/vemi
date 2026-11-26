import { useEffect, useState } from "react";
import { UPDATE_DOCS } from "../../shared/releaseKey.js";
import { KEY_LIST_LINK } from "../../shared/setup/getFlow.js";
import { StatusWord } from "./Group.js";
import { updateSettingsApi, type UpdateSettings, type UpdateSettingsApi } from "../updateApi.js";

/** What the owner is told once the key is gone; the Worker's own sentence is shown as it comes. */
const NOT_UNDONE = "Data changes are not undone.";

/** The day a window lasts to, in the person's own words for dates. */
const dayOf = (iso: string): string => {
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? iso : at.toLocaleDateString(undefined, { day: "numeric", month: "long" });
};

/**
 * The owner's rows for going back and for Update myself. Go back shows for the 7 days after an
 * update; once used it reads "Back on <version>". Update myself reads On while the copy holds a key
 * and the owner can turn it Off by typing off, after which it reads Off and cannot be turned on here.
 */
export function AccountUpdateView({ settings, said, problem, busy, asking, word, onBack, onAsk, onWord, onOff }: {
  readonly settings: UpdateSettings;
  /** What the Worker said once the key was removed. */
  readonly said: string | null;
  readonly problem: string | null;
  readonly busy: boolean;
  readonly asking: boolean;
  readonly word: string;
  readonly onBack: () => void;
  readonly onAsk: () => void;
  readonly onWord: (word: string) => void;
  readonly onOff: () => void;
}) {
  const { goBack, backed, keyKept } = settings;
  return (
    <>
      {goBack !== null && (
        <>
          <div className="account-row">
            <span className="account-row-title">
              Go back to {goBack.version}
              <span className="account-row-note">Until {dayOf(goBack.until)}</span>
            </span>
            <button type="button" className="row-action" disabled={busy} onClick={onBack}>Go back</button>
          </div>
          {goBack.restorePoint !== null && (
            <div className="account-row">
              <span className="account-row-title">
                Restore point
                <span className="account-row-note update-notes">{goBack.restorePoint}</span>
                <span className="account-row-note">{NOT_UNDONE}</span>
              </span>
              <a className="row-action" href={UPDATE_DOCS} target="_blank" rel="noreferrer noopener">Restore data</a>
            </div>
          )}
        </>
      )}
      {backed !== null && (
        <div className="account-row">
          <span className="account-row-title">Back on {backed}</span>
        </div>
      )}
      <div className="account-row">
        <span className="account-row-title">
          Update myself
          <span className="account-row-note"><StatusWord on={keyKept}>{keyKept ? "On" : "Off"}</StatusWord></span>
        </span>
        {keyKept && <button type="button" className="row-action quiet" disabled={busy} onClick={onAsk}>Turn off</button>}
      </div>
      {keyKept && asking && (
        <form className="account-form" onSubmit={(e) => { e.preventDefault(); if (!busy && word === "off") onOff(); }}>
          <input className="field" type="text" autoComplete="off" aria-label="Type off to turn off" placeholder="off"
            value={word} onChange={(e) => onWord(e.target.value)} />
          <button type="submit" className="primary-button" disabled={busy || word !== "off"}>Turn off</button>
        </form>
      )}
      {said !== null && (
        <div className="account-row">
          <span className="account-row-title">
            {said}
            <span className="account-row-note"><a href={KEY_LIST_LINK} target="_blank" rel="noreferrer noopener">Open your Cloudflare keys</a></span>
          </span>
        </div>
      )}
      {problem !== null && <div className="error" role="alert">{problem}</div>}
    </>
  );
}

/** Reads the settings, and does Go back and Off. Shows nothing until the Worker has answered. */
export function AccountUpdate({ api }: { readonly api?: UpdateSettingsApi }) {
  const [client] = useState(() => api ?? updateSettingsApi());
  const [settings, setSettings] = useState<UpdateSettings | null>(null);
  const [said, setSaid] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [asking, setAsking] = useState(false);
  const [word, setWord] = useState("");

  useEffect(() => {
    let live = true;
    client.read().then((found) => { if (live) setSettings(found); }, () => undefined);
    return () => { live = false; };
  }, [client]);

  async function run(work: () => Promise<void>): Promise<void> {
    setBusy(true);
    setProblem(null);
    try {
      await work();
    } catch (error) {
      setProblem(error instanceof Error ? error.message : "VEMI could not do that. Try again.");
    } finally {
      setBusy(false);
    }
  }

  if (settings === null) return null;
  return (
    <AccountUpdateView
      settings={settings}
      said={said}
      problem={problem}
      busy={busy}
      asking={asking}
      word={word}
      onAsk={() => setAsking((was) => !was)}
      onWord={setWord}
      onBack={() => void run(async () => {
        await client.goBack();
        setSettings(await client.read());
      })}
      onOff={() => void run(async () => {
        setSaid(await client.turnOff());
        setSettings(await client.read());
        setAsking(false);
        setWord("");
      })}
    />
  );
}
