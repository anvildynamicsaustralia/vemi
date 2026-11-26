/**
 * Before anything is sent: a file that holds locked content asks for one of its own ways in, so a
 * move that could never be finished is not started. The key opens here and is let go at once;
 * nothing in this file sends it or keeps it.
 */
import { useState, type ReactElement } from "react";
import { prfPossible } from "../passkeyPrf.js";
import type { OpenWay } from "../keyWays.js";
import type { LockedHeld } from "../moveLocked.js";

export const KEY_WORDS = {
  title: "Open your locked notes first",
  passkey: "Face ID or fingerprint",
  password: "Vault password",
  usePassword: "Use vault password",
  recovery: "Recovery key",
  useRecovery: "Use recovery key",
} as const;

/** The ways in the file's own key rows offer, and this device can do. */
export function waysOf(keys: LockedHeld["keys"], prf: boolean): { readonly passkey: boolean; readonly password: boolean; readonly recovery: boolean } {
  const live = (kind: string): boolean => keys !== null && keys.wraps.some((w) => w.kind === kind);
  return { passkey: prf && live("passkey"), password: live("password"), recovery: live("recovery") };
}

export function MoveKey({ keys, problem, onProve }: {
  readonly keys: LockedHeld["keys"];
  readonly problem: string | null;
  readonly onProve: (way: OpenWay) => void;
}): ReactElement {
  const [password, setPassword] = useState("");
  const [recoveryKey, setRecoveryKey] = useState("");
  const ways = waysOf(keys, prfPossible());
  return (
    <section className="get-missing" aria-label={KEY_WORDS.title}>
      <p className="get-subhead">{KEY_WORDS.title}</p>
      {ways.passkey && <button type="button" className="get-secondary" onClick={() => onProve({ kind: "passkey" })}>{KEY_WORDS.passkey}</button>}
      {ways.password && (
        <form className="get-field" onSubmit={(e) => { e.preventDefault(); if (password !== "") onProve({ kind: "password", password }); }}>
          <label htmlFor="get-vault">{KEY_WORDS.password}</label>
          <input id="get-vault" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
          <button type="submit" className="get-secondary" disabled={password === ""}>{KEY_WORDS.usePassword}</button>
        </form>
      )}
      {ways.recovery && (
        <form className="get-field" onSubmit={(e) => { e.preventDefault(); if (recoveryKey !== "") onProve({ kind: "recovery", recoveryKey }); }}>
          <label htmlFor="get-recovery-key">{KEY_WORDS.recovery}</label>
          <input id="get-recovery-key" type="text" autoComplete="off" spellCheck={false} value={recoveryKey} onChange={(e) => setRecoveryKey(e.target.value)} />
          <button type="submit" className="get-secondary" disabled={recoveryKey === ""}>{KEY_WORDS.useRecovery}</button>
        </form>
      )}
      {problem !== null && <p className="get-fault" role="alert">{problem}</p>}
    </section>
  );
}
