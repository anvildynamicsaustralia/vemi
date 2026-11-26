import { useState } from "react";
import { PASSWORD_MIN } from "@vemi/shared";
import { KeyWayError, type Opened, type PendingKey, type SetUpWay } from "../keyWays.js";
import { RecoveryKey } from "./RecoveryKey.js";
import "./privacy.css";

type Stage =
  | { readonly at: "start" }
  | { readonly at: "password"; readonly note: string | null }
  | { readonly at: "recovery"; readonly pending: PendingKey };

const sentence = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * Setting up a key: Face ID or a fingerprint where this device can, else a vault password; then the
 * recovery key, shown once. Nothing reaches the Worker until the recovery key's last group has been
 * typed and Done is pressed, so leaving part way leaves no half key.
 */
export function KeySetup({ prepare, prf, onSaved }: {
  /** Makes the key with one way in and returns it unsent (`prepareSetUp`, or `prepareStartAgain`). */
  readonly prepare: (way: SetUpWay) => Promise<PendingKey>;
  /** Whether this device can do Face ID or a fingerprint with a key behind it. */
  readonly prf: boolean;
  readonly onSaved: (opened: Opened) => void;
}) {
  const [stage, setStage] = useState<Stage>(prf ? { at: "start" } : { at: "password", note: null });
  const [password, setPassword] = useState("");
  const [again, setAgain] = useState("");
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

  const usePasskey = (): Promise<void> => run(async () => {
    try {
      setStage({ at: "recovery", pending: await prepare({ kind: "passkey" }) });
    } catch (error) {
      // No result from this device's authenticator: the vault password is the way in.
      if (error instanceof KeyWayError && error.problem === "nopasskey") {
        setStage({ at: "password", note: "This device could not set up Face ID or a fingerprint." });
        return;
      }
      throw error;
    }
  });

  const usePassword = (): Promise<void> => run(async () => {
    if (password.length < PASSWORD_MIN) throw new KeyWayError("weak", `Use at least ${PASSWORD_MIN} characters.`);
    if (password !== again) throw new KeyWayError("weak", "The two don't match.");
    setStage({ at: "recovery", pending: await prepare({ kind: "password", password }) });
    setPassword("");
    setAgain("");
  });

  const finish = (pending: PendingKey): Promise<void> => run(async () => { onSaved(await pending.save()); });

  if (stage.at === "recovery") {
    return <RecoveryKey recoveryKey={stage.pending.recoveryKey} busy={busy} problem={problem} onDone={() => void finish(stage.pending)} />;
  }
  if (stage.at === "start") {
    return (
      <div className="account-form key-setup">
        <button type="button" className="primary-button" disabled={busy} onClick={() => void usePasskey()}>Face ID or fingerprint</button>
        <button type="button" className="row-action" disabled={busy} onClick={() => setStage({ at: "password", note: null })}>Vault password</button>
        {problem !== null && <span className="account-row-note" role="alert">{problem}</span>}
      </div>
    );
  }
  return (
    <form className="account-form key-setup" onSubmit={(e) => { e.preventDefault(); if (!busy) void usePassword(); }}>
      {stage.note !== null && <span className="account-row-note">{stage.note}</span>}
      <input className="field" type="password" autoComplete="new-password" placeholder="Vault password" aria-label="Vault password"
        value={password} onChange={(e) => setPassword(e.target.value)} />
      <input className="field" type="password" autoComplete="new-password" placeholder="Vault password again" aria-label="Vault password again"
        value={again} onChange={(e) => setAgain(e.target.value)} />
      <span className="account-row-note">Not your sign-in password.</span>
      {problem !== null && <span className="account-row-note" role="alert">{problem}</span>}
      <button type="submit" className="primary-button" disabled={busy || password === "" || again === ""}>Continue</button>
    </form>
  );
}
