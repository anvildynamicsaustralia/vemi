import { useEffect, useRef, useState, type ReactElement } from "react";
import type { KeyState } from "../api.js";
import { api, keysNow, makeMoveCode, previewRestore, paths, removeSavedFilter, restoreFrom, saveFilter, scheduleDeletion } from "../api.js";
import type { Me } from "../auth.js";
import type { DeviceKey } from "../deviceKey.js";
import { countSealed, fetchExport, saveExport, unlockExport } from "../exportLocked.js";
import { keyWays, type OpenWay } from "../keyWays.js";
import { prfPossible } from "../passkeyPrf.js";
import { countLines, deletionDay, readRestoreFile } from "../restoreFile.js";
import { fileKeyState, openKey } from "../restoreLocked.js";
import { countEnvelopes, restoreReseal } from "../restoreReseal.js";
import { encryptionState } from "../sealedApi.js";
import { isLocal, LOCAL_KEY_NAME } from "../local/mode.js";
import { onVolatile, volatileNow } from "../local/parts.js";
import { keepingAnswer, keepingRule, keepingSeen, KEEPING_MAY_CLEAR, KEEPING_NOTHING, markKeepingSeen, pageStore, platformOf, type Keeping } from "../local/persist.js";
import { isStandalone } from "../installPrompt.js";
import { navigate, surface } from "../router.js";
import { useApp } from "./appContext.js";
import { ProofForm, proofWays } from "./KeyPair.js";
import { MoveCode } from "./MoveCode.js";
import { MoveStart } from "./MoveStart.js";
import { useVault } from "./vaultContext.js";
import { WantYourOwn } from "./WantYourOwn.js";
import "./deletionBar.css";

/** A file chosen for restore: its document, and what the Worker counted in it. */
interface Chosen {
  readonly name: string;
  readonly document: Record<string, unknown>;
  readonly lines: readonly string[];
  /** How many locked fields the file holds, as the Worker counted. */
  readonly locked: number;
  /** The file's own key rows, when it holds locked fields. */
  readonly keys: KeyState | null;
  /** The field key one of the file's ways in opened. */
  readonly key: Pick<DeviceKey, "fieldKey" | "keyRef"> | null;
}

/** An export fetched and waiting for the answer about its locked content. */
interface Fetched {
  readonly document: Record<string, unknown>;
  readonly keys: KeyState | null;
}

/** Where a copy kept in the page says its data is, and the way off the device. The label stays when the move itself is wired. */
export const LOCAL_KEPT = "Kept on this device only";

/**
 * What Your data says about keeping the data. The warning that the browser may clear it is shown
 * the first time it applies and never again once seen; "nothing is kept" is shown on every open.
 */
function useKeeping(local: boolean): Keeping {
  const [keeping, setKeeping] = useState<Keeping>("none");
  const shown = useRef(false);
  useEffect(() => {
    if (!local) return;
    let live = true;
    const store = pageStore();
    // Said once: this open decides at the start, so the line stays up while the section is open.
    // (A ref, so a development re-run of this effect does not read its own mark as an earlier view.)
    const decide = async (): Promise<void> => {
      const persisted = await keepingAnswer(store);
      if (!live) return;
      const rule = keepingRule({
        persisted,
        volatile: volatileNow(),
        standalone: isStandalone(),
        platform: platformOf(navigator),
      });
      if (rule === "may-clear" && !shown.current) {
        if (keepingSeen(store)) return setKeeping("none");
        shown.current = true;
        markKeepingSeen(store);
      }
      setKeeping(rule);
    };
    void decide();
    const off = onVolatile(() => { void decide(); });
    return () => { live = false; off(); };
  }, [local]);
  return keeping;
}

const said = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * Account > Your data: the archive, the export, a restore from a file and, for anyone but the
 * owner of the copy, scheduling this account to go. Restore and deletion both wait for a word typed.
 */
export function AccountData({ who, refresh, local = isLocal() }: {
  readonly local?: boolean;
  readonly who: Me | null;
  /** Asks the Worker who is signed in again, so the bar sees a deletion at once. */
  readonly refresh: () => Promise<void>;
}) {
  const app = useApp();
  const vault = useVault();
  const email = who?.email ?? (local ? LOCAL_KEY_NAME : "");
  const [fetched, setFetched] = useState<Fetched | null>(null);
  const picker = useRef<HTMLInputElement>(null);
  const [chosen, setChosen] = useState<Chosen | null>(null);
  const [word, setWord] = useState("");
  const [asking, setAsking] = useState(false);
  const [goWord, setGoWord] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const keeping = useKeeping(local);

  const attempt = async (work: () => Promise<void>): Promise<void> => {
    setBusy(true);
    setProblem(null);
    try {
      await work();
    } catch (err) {
      setProblem(said(err));
    } finally {
      setBusy(false);
    }
  };

  const choose = (file: File | undefined): void => {
    if (file === undefined) return;
    setChosen(null);
    setWord("");
    void attempt(async () => {
      const read = readRestoreFile(await file.text());
      if (!read.ok) throw new Error(read.error);
      const answer = await previewRestore(read.document);
      // Counted on this device from the file itself: the Worker counts only the cells a person locks.
      const locked = Math.max(typeof answer.locked === "number" ? answer.locked : 0, countEnvelopes(read.document));
      setChosen({
        name: file.name, document: read.document, lines: countLines(answer.counts), locked,
        keys: locked > 0 ? fileKeyState(read.document) : null, key: null,
      });
    });
  };

  /** One of the file's own ways in. A wrong one changes nothing. */
  const proveFile = (way: OpenWay): Promise<void> => attempt(async () => {
    if (chosen?.keys == null) return;
    const key = await openKey(email, chosen.keys, way);
    setChosen({ ...chosen, key });
  });

  const restore = (): Promise<void> => attempt(async () => {
    if (chosen === null) return;
    if (chosen.locked > 0 && chosen.key === null) return;
    if (chosen.key === null) {
      await restoreFrom(chosen.document);
    } else {
      // Every envelope was bound to its row's old id: each moves to the new one, here, with the file's own key.
      const restored = await restoreFrom(chosen.document);
      const done = await restoreReseal(chosen.document, restored.ids ?? {}, chosen.key, {
        save: async ({ kind, id, fields }) => { await api.update(kind, id, fields); },
        replaceFilter: async (old, fresh, filter) => {
          await saveFilter(filter.name, filter.query, fresh);
          await removeSavedFilter(old);
        },
      });
      await keyWays(email).rejoin(chosen.key);
      await vault.refresh();
      if (done.left > 0) app.notify(`${done.left} encrypted ${done.left === 1 ? "item" : "items"} could not be opened and stay as the file had them.`);
    }
    app.notify("Restored.");
    // Everything on screen was drawn from the data that has just been replaced.
    window.setTimeout(() => window.location.reload(), 600);
  });

  /** Fetches the export; with locked content, waits for the answer to the question, else saves it. */
  const makeExport = (): Promise<void> => attempt(async () => {
    const document = await fetchExport(paths.export);
    // An encrypted account's export is saved as the Worker made it: envelopes and key rows, never opened here.
    if (encryptionState() !== "off" || countSealed(document) === 0) { saveExport(document); return; }
    let keys: KeyState | null = null;
    try { keys = await keysNow(); } catch { keys = null; }
    setFetched({ document, keys });
  });

  const keepLocked = (): void => {
    if (fetched === null) return;
    saveExport(fetched.document);
    setFetched(null);
  };

  const unlockAndSave = (way: OpenWay): Promise<void> => attempt(async () => {
    if (fetched?.keys == null) return;
    const key = await openKey(email, fetched.keys, way);
    const out = await unlockExport(fetched.document, key);
    saveExport(out.document);
    setFetched(null);
    if (out.left > 0) app.notify(`${out.left} locked ${out.left === 1 ? "item" : "items"} could not be opened and stay locked in the file.`);
  });

  const schedule =(): Promise<void> => attempt(async () => {
    const day = await scheduleDeletion();
    setAsking(false);
    setGoWord("");
    await refresh();
    app.notify(`This account goes on ${deletionDay(day)}. You can cancel until then.`);
  });

  return (
    <div className="account-rows">
      {local && (
        <div className="account-row">
          <span className="account-row-title">{LOCAL_KEPT}</span>
        </div>
      )}
      {local && <MoveStart />}
      {!local && who !== null && <MoveCodeMaker />}
      {!local && who?.operator === false && <WantYourOwn busy={busy} onExport={() => void makeExport()} />}
      {local && keeping !== "none" && (
        <div className="account-row" role="status">
          <span className="account-row-title">{keeping === "nothing-kept" ? KEEPING_NOTHING : KEEPING_MAY_CLEAR}</span>
          <span className="account-row-actions">
            <button type="button" className="row-action" disabled={busy} onClick={() => void makeExport()}>Export</button>
          </span>
        </div>
      )}
      <div className="account-row">
        <span className="account-row-title">
          Archive
          <span className="account-row-note">Everything put away, and the way to bring it back.</span>
        </span>
        <span className="account-row-actions">
          <button type="button" className="row-action" onClick={() => navigate(surface("archive"))}>Open</button>
        </span>
      </div>
      <div className="account-row">
        <span className="account-row-title">
          Export everything
          <span className="account-row-note">Everything you have made, archived ones included.</span>
        </span>
        <span className="account-row-actions">
          <button type="button" className="row-action" disabled={busy} onClick={() => void makeExport()}>JSON</button>
        </span>
      </div>
      {fetched !== null && (
        <div className="account-form">
          <div className="account-row-title">Keep locked content locked in the file?</div>
          <button type="button" className="primary-button" disabled={busy} onClick={keepLocked}>Yes</button>
          {fetched.keys !== null && (
            <ProofForm ways={proofWays(fetched.keys, prfPossible())} disabled={false} busy={busy} problem={null} onProve={(way) => void unlockAndSave(way)} />
          )}
          <button type="button" className="row-action" onClick={() => setFetched(null)}>Cancel</button>
        </div>
      )}
      <div className="account-row">
        <span className="account-row-title">
          Restore from a file
          <span className="account-row-note">Replaces what is here with an export file.</span>
        </span>
        <span className="account-row-actions">
          <button type="button" className="row-action" disabled={busy} onClick={() => picker.current?.click()}>Choose file</button>
          <input ref={picker} type="file" accept="application/json,.json" hidden aria-label="Export file"
            onChange={(e) => { choose(e.target.files?.[0]); e.target.value = ""; }} />
        </span>
      </div>
      {chosen !== null && (
        <div className="account-form">
          <div className="account-row-title">{chosen.name} holds</div>
          <ul className="code-list">
            {chosen.lines.map((line) => <li key={line}>{line}</li>)}
          </ul>
          {chosen.locked > 0 && chosen.keys === null && (
            <span className="account-row-note">This file holds locked content but not the way to open it, so it can't be restored here.</span>
          )}
          {/* Beside the restore form, not inside it: its own forms cannot nest in another. */}
          {chosen.locked > 0 && chosen.keys !== null && chosen.key === null && (
            <ProofForm ways={proofWays(chosen.keys, prfPossible())} disabled={false} busy={busy} problem={null} onProve={(way) => void proveFile(way)} />
          )}
          <form className="account-form" onSubmit={(e) => { e.preventDefault(); if (!busy && word === "replace" && (chosen.locked === 0 || chosen.key !== null)) void restore(); }}>
            <input className="field" type="text" autoComplete="off" aria-label="Type replace to restore" placeholder="replace"
              value={word} onChange={(e) => setWord(e.target.value)} />
            <button type="submit" className="primary-button" disabled={busy || word !== "replace" || (chosen.locked > 0 && chosen.key === null)}>Replace everything</button>
          </form>
        </div>
      )}
      {who?.operator === false && (
        <div className="account-row">
          <span className="account-row-title">
            Delete my account
            <span className="account-row-note">Goes after 7 days. You can cancel until then.</span>
          </span>
          <span className="account-row-actions">
            <button type="button" className="row-action quiet" disabled={busy || who.deleteOn != null}
              onClick={() => setAsking((was) => !was)}>Delete</button>
          </span>
        </div>
      )}
      {asking && who?.operator === false && (
        <form className="account-form" onSubmit={(e) => { e.preventDefault(); if (!busy && goWord === "delete") void schedule(); }}>
          <input className="field deletion-confirm" type="text" autoComplete="off" aria-label="Type delete to schedule" placeholder="delete"
            value={goWord} onChange={(e) => setGoWord(e.target.value)} />
          <button type="submit" className="primary-button" disabled={busy || goWord !== "delete"}>Delete my account</button>
        </form>
      )}
      {problem !== null && <div className="error" role="alert">{problem}</div>}
    </div>
  );
}

/** For a signed-in account: makes a move code another place can move into this one with. */
function MoveCodeMaker(): ReactElement {
  const [made, setMade] = useState<{ readonly code: string; readonly expiresAt: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const make = (): void => {
    setBusy(true);
    setProblem(null);
    makeMoveCode().then(setMade, (err: unknown) => setProblem(said(err))).finally(() => setBusy(false));
  };
  return (
    <>
      <div className="account-row">
        <span className="account-row-title">
          Move code
          <span className="account-row-note">Good for 15 minutes, once.</span>
        </span>
        <span className="account-row-actions">
          <button type="button" className="row-action" disabled={busy} onClick={make}>Make a code</button>
        </span>
      </div>
      {made !== null && <MoveCode code={made.code} expiresAt={made.expiresAt} />}
      {problem !== null && <div className="error" role="alert">{problem}</div>}
    </>
  );
}
