import { useEffect, useMemo, useRef, useState } from "react";
import type { KeyState } from "../api.js";
import { type EncryptionApi, encryptionApi } from "../encryptionApi.js";
import { type HeldKey, WAITING, encryptionRun } from "../encryptionRun.js";
import { forgetKeptData } from "../keptData.js";
import type { OpenWay, Opened, PendingKey, SetUpWay } from "../keyWays.js";
import { type EncryptionState, encryptionState, setEncryptionState } from "../sealedApi.js";
import { clearResources } from "../state/resources.js";
import { queued } from "../state/outbox.js";
import { KeySetup } from "./KeySetup.js";
import { ProofForm, proofWays } from "./KeyPair.js";
import { StatusWord } from "./Group.js";
import "./privacy.css";

/** The five lines said before it is turned on. Nothing else on the screen tells the person what to do. */
export const ENCRYPTION_LINES: readonly string[] = [
  "Search runs on your devices.",
  "Reminders show titles only on your devices.",
  "The AI connector can't read this account.",
  "If you lose every device and your recovery key, nobody can get your data back.",
  "It takes a minute.",
];

export type EncryptionStep =
  | { readonly at: "row" }
  | { readonly at: "explain" }
  | { readonly at: "prove"; readonly to: "on" | "off" }
  | { readonly at: "working"; readonly to: "on" | "off"; readonly done: number; readonly total: number };

const unfinished = (state: EncryptionState): boolean => state === "turning_on" || state === "turning_off";

/** The full-account row of Privacy and security, drawn from where the account is. Pure. */
export function EncryptionPanel({ state, step, ways, busy, problem, on }: {
  readonly state: EncryptionState;
  readonly step: EncryptionStep;
  readonly ways: ReturnType<typeof proofWays>;
  readonly busy: boolean;
  readonly problem: string | null;
  readonly on: {
    readonly turnOn: () => void;
    readonly turnOff: () => void;
    readonly carryOn: () => void;
    readonly confirm: () => void;
    readonly prove: (way: OpenWay) => void;
    readonly back: () => void;
  };
}) {
  const alert = problem !== null && <span className="account-row-note" role="alert">{problem}</span>;
  if (step.at === "working") {
    return (
      <div className="encryption-panel">
        <div className="account-row">
          <span className="account-row-title">Full account encryption</span>
        </div>
        <progress className="encryption-bar" max={step.total} value={step.done} aria-label="Progress" />
        {alert}
      </div>
    );
  }
  if (step.at === "explain") {
    return (
      <div className="encryption-panel">
        <div className="account-row">
          <span className="account-row-title">Full account encryption</span>
        </div>
        <ul className="encryption-lines">
          {ENCRYPTION_LINES.map((line) => <li key={line}>{line}</li>)}
        </ul>
        <div className="encryption-actions">
          <button type="button" className="primary-button" disabled={busy} onClick={on.confirm}>Turn on</button>
          <button type="button" className="row-action quiet" disabled={busy} onClick={on.back}>Not now</button>
        </div>
        {alert}
      </div>
    );
  }
  if (step.at === "prove") {
    return (
      <div className="encryption-panel">
        <div className="account-row">
          <span className="account-row-title">Full account encryption</span>
          <button type="button" className="row-action quiet" disabled={busy} onClick={on.back}>Not now</button>
        </div>
        <ProofForm ways={ways} disabled={false} busy={busy} problem={problem} onProve={on.prove} />
      </div>
    );
  }
  return (
    <div className="encryption-panel">
      <div className="account-row">
        <span className="account-row-title">
          Full account encryption
          <span className="account-row-note">
            <StatusWord on={state === "on"}>
              {state === "on" ? "On" : state === "off" ? "Off" : state === "turning_on" ? "Turning on is not finished" : "Turning off is not finished"}
            </StatusWord>
          </span>
        </span>
        {state === "off" && <button type="button" className="row-action" disabled={busy} onClick={on.turnOn}>Turn on</button>}
        {state === "on" && <button type="button" className="row-action" disabled={busy} onClick={on.turnOff}>Turn off</button>}
        {unfinished(state) && <button type="button" className="row-action" disabled={busy} onClick={on.carryOn}>Continue</button>}
      </div>
      {alert}
    </div>
  );
}

type Shown = { readonly at: "row" } | { readonly at: "setup" };

/**
 * The row, with the key and the run behind it. Turning on sets up a key first when the account
 * has none; turning off asks one way in again. A reload part way offers Continue, read from the
 * Worker's own state. The run itself is `encryptionRun`.
 */
export function AccountEncryption({ ways, keys, prf, onKeySaved, api }: {
  readonly ways: {
    readonly held: () => Promise<HeldKey | null>;
    readonly prove: (way: OpenWay) => Promise<void>;
    readonly openWith: (way: OpenWay) => Promise<Opened>;
    readonly prepareSetUp: (way: SetUpWay) => Promise<PendingKey>;
  };
  /** Null until the Worker has answered. */
  readonly keys: KeyState | null;
  readonly prf: boolean;
  readonly onKeySaved: (opened: Opened) => void;
  readonly api?: EncryptionApi;
}) {
  const calls = useMemo(() => api ?? encryptionApi(), [api]);
  const [state, setState] = useState<EncryptionState>(encryptionState);
  const [shown, setShown] = useState<Shown>({ at: "row" });
  const [step, setStep] = useState<EncryptionStep>({ at: "row" });
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  // A key made or opened on this visit, for a browser that cannot keep one.
  const fresh = useRef<HeldKey | null>(null);
  const running = useRef(false);

  useEffect(() => {
    let live = true;
    calls.report().then((r) => { if (live) { setState(r.state); setEncryptionState(r.state); } }, () => undefined);
    return () => { live = false; };
  }, [calls]);

  const say = (error: unknown): void => setProblem(error instanceof Error ? error.message : String(error));

  async function go(to: "on" | "off", key: HeldKey): Promise<void> {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setProblem(null);
    setStep({ at: "working", to, done: 0, total: 1 });
    try {
      const end = await encryptionRun(to, {
        api: calls,
        key,
        ...(keys?.keyRef != null ? { expectKeyRef: keys.keyRef } : {}),
        waiting: () => queued().length,
        progress: (p) => setStep({ at: "working", to, done: p.done, total: p.total }),
        setState: (s) => { setEncryptionState(s); setState(s); },
        forget: async () => { clearResources(); await forgetKeptData(); },
      });
      if (!end.ok) setProblem(end.said);
    } finally {
      running.current = false;
      setBusy(false);
      setStep({ at: "row" });
      // Where the Worker says it is, whichever way it ended.
      await calls.report().then((r) => { setState(r.state); setEncryptionState(r.state); }, () => undefined);
    }
  }

  async function keyHere(): Promise<HeldKey | null> {
    return fresh.current ?? (await ways.held());
  }

  /** Runs now with the key this device holds, or asks one way in first. */
  async function begin(to: "on" | "off", askAgain: boolean): Promise<void> {
    setProblem(null);
    // Refused before a way in is asked for: nothing waiting in this browser may be left in plain text.
    if (queued().length > 0) {
      setStep({ at: "row" });
      setProblem(WAITING);
      return;
    }
    const held = askAgain ? null : await keyHere();
    if (held !== null) {
      await go(to, held);
      return;
    }
    setStep({ at: "prove", to });
  }

  async function prove(way: OpenWay): Promise<void> {
    if (step.at !== "prove") return;
    const to = step.to;
    setBusy(true);
    setProblem(null);
    try {
      const held = await ways.held();
      let key: HeldKey;
      if (held !== null) {
        await ways.prove(way);
        key = held;
      } else {
        const opened = await ways.openWith(way);
        fresh.current = opened;
        key = opened;
        onKeySaved(opened);
      }
      setBusy(false);
      await go(to, key);
    } catch (error) {
      say(error);
      setBusy(false);
    }
  }

  const onKeys = keys !== null && keys.keyRef !== null;

  if (shown.at === "setup") {
    return (
      <KeySetup prepare={(way) => ways.prepareSetUp(way)} prf={prf}
        onSaved={(opened) => {
          fresh.current = opened;
          onKeySaved(opened);
          setShown({ at: "row" });
          setStep({ at: "explain" });
        }} />
    );
  }

  return (
    <EncryptionPanel
      state={state} step={step} busy={busy} problem={problem}
      ways={keys === null ? { passkey: false, password: false, recovery: false } : proofWays(keys, prf)}
      on={{
        turnOn: () => { setProblem(null); if (keys === null) return; if (onKeys) setStep({ at: "explain" }); else setShown({ at: "setup" }); },
        turnOff: () => void begin("off", true),
        carryOn: () => void begin(state === "turning_on" ? "on" : "off", state === "turning_off"),
        confirm: () => void begin("on", false),
        prove: (way) => void prove(way),
        back: () => { setProblem(null); setStep({ at: "row" }); },
      }} />
  );
}
