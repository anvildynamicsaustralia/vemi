import { useState } from "react";
import { asksForCode, signIn } from "../auth.js";
import type { KeyState } from "../api.js";
import type { OpenWay, Opened, PendingKey, SetUpWay, keyWays } from "../keyWays.js";
import { KeyPair, proofWays } from "./KeyPair.js";
import { KeySetup } from "./KeySetup.js";
import "./privacy.css";

const REFUSED = "That didn't work. Try again.";
const DECLINED = "vemi-passkey-offer";
const sentence = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** What opening needs from the key's orchestration. */
export type UnlockWays = Pick<ReturnType<typeof keyWays>, "openWith" | "addWay" | "startPairing" | "finishPairing" | "prepareStartAgain">;

/** Which row is open, or the lost-every-way-in steps. */
export type UnlockStep = "idle" | "password" | "recovery" | "lost" | "again";

export interface UnlockHandlers {
  readonly ask: (step: UnlockStep) => void;
  readonly open: (way: OpenWay) => void;
  readonly pair: () => void;
  /** The sign-in password, typed to start again. */
  readonly confirm: (password: string) => void;
}

/** The ways in on a device that holds no key: a passkey only where a live row exists and this device can use it. */
export function unlockWays(keys: KeyState, prf: boolean): { readonly passkey: boolean; readonly password: boolean; readonly recovery: boolean } {
  return { ...proofWays(keys, prf), recovery: true };
}

/** Whether this device was already asked once about Face ID or a fingerprint and said Not now. */
export function offerDeclined(): boolean {
  try {
    return localStorage.getItem(DECLINED) === "1";
  } catch {
    return false;
  }
}

export function declineOffer(): void {
  try {
    localStorage.setItem(DECLINED, "1");
  } catch {
    // Asked again next time; nothing worse.
  }
}

/** Whether the person is offered Face ID or a fingerprint after `way` opened the key (C18). */
export function offersPasskey(way: OpenWay, opened: Opened, prf: boolean, declined: boolean): boolean {
  return way.kind !== "passkey" && prf && opened.kept && !declined;
}

/** True when the sign-in password is right. A refusal asking for a 2-step code means the password was. */
export async function confirmSignIn(email: string, password: string): Promise<boolean> {
  try {
    await signIn(email, password);
    return true;
  } catch (error) {
    return asksForCode(error);
  }
}

/** The ways in, a way to lose them all, and what each asks. Pure. */
export function UnlockView({ keys, prf, step, busy, problem, on }: {
  readonly keys: KeyState;
  readonly prf: boolean;
  readonly step: UnlockStep;
  readonly busy: boolean;
  readonly problem: string | null;
  readonly on: UnlockHandlers;
}) {
  const ways = unlockWays(keys, prf);
  const [password, setPassword] = useState("");
  const [recoveryKey, setRecoveryKey] = useState("");
  const [signInPassword, setSignInPassword] = useState("");
  const toggle = (next: UnlockStep): void => on.ask(step === next ? "idle" : next);
  const alert = problem !== null && <span className="account-row-note" role="alert">{problem}</span>;
  return (
    <div className="privacy-rows key-unlock">
      {ways.passkey && (
        <div className="account-row">
          <span className="account-row-title">Face ID or fingerprint</span>
          <button type="button" className="row-action" disabled={busy} onClick={() => on.open({ kind: "passkey" })}>Use</button>
        </div>
      )}
      {ways.password && (
        <>
          <div className="account-row">
            <span className="account-row-title">Vault password</span>
            <button type="button" className="row-action" disabled={busy} onClick={() => toggle("password")}>Use</button>
          </div>
          {step === "password" && (
            <form className="account-form" onSubmit={(e) => { e.preventDefault(); if (!busy && password !== "") on.open({ kind: "password", password }); }}>
              <input className="field" type="password" autoComplete="current-password" placeholder="Vault password" aria-label="Vault password"
                value={password} onChange={(e) => setPassword(e.target.value)} />
              <button type="submit" className="primary-button" disabled={busy || password === ""}>Use vault password</button>
            </form>
          )}
        </>
      )}
      <div className="account-row">
        <span className="account-row-title">Recovery key</span>
        <button type="button" className="row-action" disabled={busy} onClick={() => toggle("recovery")}>Use</button>
      </div>
      {step === "recovery" && (
        <form className="account-form" onSubmit={(e) => { e.preventDefault(); if (!busy && recoveryKey !== "") on.open({ kind: "recovery", recoveryKey }); }}>
          <input className="field" type="text" autoComplete="off" spellCheck={false} placeholder="Recovery key" aria-label="Recovery key"
            value={recoveryKey} onChange={(e) => setRecoveryKey(e.target.value)} />
          <button type="submit" className="primary-button" disabled={busy || recoveryKey === ""}>Use recovery key</button>
        </form>
      )}
      <div className="account-row">
        <span className="account-row-title">Use another device</span>
        <button type="button" className="row-action" disabled={busy} onClick={on.pair}>Show QR</button>
      </div>
      <div className="account-row">
        <span className="account-row-title">I've lost every way in</span>
        <button type="button" className="row-action quiet" disabled={busy} onClick={() => toggle("lost")}>Open</button>
      </div>
      {(step === "lost" || step === "again") && (
        <div className="account-form">
          <span className="account-row-note">Locked things can't be opened without one of these.</span>
          {step === "lost" && (
            <button type="button" className="primary-button" disabled={busy} onClick={() => on.ask("again")}>Start again with a new key</button>
          )}
          {step === "again" && (
            <form className="account-form" onSubmit={(e) => { e.preventDefault(); if (!busy && signInPassword !== "") on.confirm(signInPassword); }}>
              <input className="field" type="password" autoComplete="current-password" placeholder="Sign-in password" aria-label="Sign-in password"
                value={signInPassword} onChange={(e) => setSignInPassword(e.target.value)} />
              <button type="submit" className="primary-button" disabled={busy || signInPassword === ""}>Start again with a new key</button>
            </form>
          )}
        </div>
      )}
      {alert}
    </div>
  );
}

/** Offered once after a way in without Face ID or a fingerprint, on a device that could have one. Pure. */
export function PasskeyOffer({ busy, problem, onUse, onNotNow }: {
  readonly busy: boolean;
  readonly problem: string | null;
  readonly onUse: () => void;
  readonly onNotNow: () => void;
}) {
  return (
    <div className="account-form key-offer">
      <button type="button" className="primary-button" disabled={busy} onClick={onUse}>Use Face ID or fingerprint here</button>
      <button type="button" className="row-action quiet" disabled={busy} onClick={onNotNow}>Not now</button>
      {problem !== null && <span className="account-row-note" role="alert">{problem}</span>}
    </div>
  );
}

type Stage =
  | { readonly at: "ways" }
  | { readonly at: "pair" }
  | { readonly at: "setup" }
  | { readonly at: "offer"; readonly proof: OpenWay; readonly opened: Opened };

/**
 * A device signed in to an account that has a key but holds none: every way in the key has, from
 * one place. `onOpened` runs once the key is kept here (or, where the browser cannot keep it, held
 * for this visit).
 */
export function KeyUnlock({ ways, keys, prf, email, origin, onOpened, confirmPassword = (password) => confirmSignIn(email ?? "", password) }: {
  readonly ways: UnlockWays;
  readonly keys: KeyState;
  readonly prf: boolean;
  readonly email: string | null;
  readonly origin: string;
  readonly onOpened: (opened: Opened) => void;
  readonly confirmPassword?: (password: string) => Promise<boolean>;
}) {
  const [stage, setStage] = useState<Stage>({ at: "ways" });
  const [step, setStep] = useState<UnlockStep>("idle");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const run = async (work: () => Promise<void>): Promise<void> => {
    setBusy(true);
    setProblem(null);
    try {
      await work();
    } catch (error) {
      setProblem(sentence(error));
    } finally {
      setBusy(false);
    }
  };

  const opened = (way: OpenWay, made: Opened): void => {
    if (offersPasskey(way, made, prf, offerDeclined())) setStage({ at: "offer", proof: way, opened: made });
    else onOpened(made);
  };

  if (stage.at === "pair") {
    return <KeyPair ways={ways} origin={origin} onOpened={onOpened} onBack={() => setStage({ at: "ways" })} />;
  }
  if (stage.at === "setup") {
    return <KeySetup prepare={(way: SetUpWay): Promise<PendingKey> => ways.prepareStartAgain(way)} prf={prf} onSaved={onOpened} />;
  }
  if (stage.at === "offer") {
    const { proof, opened: made } = stage;
    return (
      <PasskeyOffer busy={busy} problem={problem}
        onUse={() => void run(async () => { await ways.addWay({ kind: "passkey" }, proof); onOpened(made); })}
        onNotNow={() => { declineOffer(); onOpened(made); }} />
    );
  }
  const on: UnlockHandlers = {
    ask: (next) => { setProblem(null); setStep(next); },
    open: (way) => void run(async () => { opened(way, await ways.openWith(way)); }),
    pair: () => { setProblem(null); setStage({ at: "pair" }); },
    confirm: (password) => void run(async () => {
      if (!(await confirmPassword(password))) throw new Error(REFUSED);
      setStage({ at: "setup" });
    }),
  };
  return <UnlockView keys={keys} prf={prf} step={step} busy={busy} problem={problem} on={on} />;
}
