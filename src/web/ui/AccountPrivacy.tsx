import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { PASSWORD_MIN } from "@vemi/shared";
import { keysNow, type KeyState } from "../api.js";
import { dataHome } from "../dataHome.js";
import { isLocal } from "../local/mode.js";
import { AccountEncryption } from "./AccountEncryption.js";
import { AppLockRow } from "./AppLock.js";
import { keyWays, type OpenWay, type Opened, type PendingRecovery } from "../keyWays.js";
import { clearLandedPair, landedPair } from "../pairLink.js";
import { prfPossible } from "../passkeyPrf.js";
import { PairApprove, ProofForm, proofWays } from "./KeyPair.js";
import { KeySetup } from "./KeySetup.js";
import { KeyUnlock } from "./KeyUnlock.js";
import { RecoveryKey } from "./RecoveryKey.js";
import { useVault, type VaultView } from "./vaultContext.js";
import "./privacy.css";

export { proofWays };

/** Which row is asking for one way in. */
export type PrivacyStep = "idle" | "passkey" | "password" | "recovery";

export interface PrivacyHandlers {
  readonly setUp: () => void;
  readonly remove: (id: string) => void;
  readonly ask: (step: PrivacyStep) => void;
  /** One way in, and for a new vault password the password it replaces the old one with. */
  readonly prove: (way: OpenWay, newPassword?: string) => void;
}

/** A key just saved or opened here: the vault is told, so every screen sees it open, and then the rows are read again. */
export function keyReady(vault: Pick<VaultView, "opened">, opened: Opened, reload: () => void): void {
  vault.opened(opened);
  reload();
}

const sentence = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** "2026-11-19": the day a row was added, from its stamp. */
export function addedOn(stamp: string): string {
  return stamp.slice(0, 10);
}

function NewPasswordForm({ ways, busy, problem, onProve }: {
  readonly ways: ReturnType<typeof proofWays>;
  readonly busy: boolean;
  readonly problem: string | null;
  readonly onProve: (way: OpenWay, newPassword: string) => void;
}) {
  const [password, setPassword] = useState("");
  const [again, setAgain] = useState("");
  const valid = password.length >= PASSWORD_MIN && password === again;
  return (
    <div className="account-form">
      <input className="field" type="password" autoComplete="new-password" placeholder="New vault password" aria-label="New vault password"
        value={password} onChange={(e) => setPassword(e.target.value)} />
      <input className="field" type="password" autoComplete="new-password" placeholder="New vault password again" aria-label="New vault password again"
        value={again} onChange={(e) => setAgain(e.target.value)} />
      <span className="account-row-note">Not your sign-in password.</span>
      <ProofForm ways={ways} disabled={!valid} busy={busy} problem={problem} onProve={(way) => onProve(way, password)} />
    </div>
  );
}

/** The key rows of Privacy and security, drawn from what the Worker lists. Pure. */
export function PrivacyRows({ keys, here, prf, step, busy, problem, on }: {
  /** Null until the Worker has answered. */
  readonly keys: KeyState | null;
  /** This device's row id, or null when this device holds no key. */
  readonly here: string | null;
  readonly prf: boolean;
  readonly step: PrivacyStep;
  readonly busy: boolean;
  readonly problem: string | null;
  readonly on: PrivacyHandlers;
}) {
  if (keys === null || keys.keyRef === null) {
    return (
      <div className="privacy-rows">
        <div className="account-row">
          <span className="account-row-title">Locking</span>
          <button type="button" className="row-action" disabled={busy || keys === null} onClick={on.setUp}>Set up</button>
        </div>
        {problem !== null && <span className="account-row-note" role="alert">{problem}</span>}
      </div>
    );
  }
  const devices = keys.wraps.filter((w) => w.kind === "device");
  const passkeys = keys.wraps.filter((w) => w.kind === "passkey");
  const hasPassword = keys.wraps.some((w) => w.kind === "password");
  const passkeyHere = here !== null && passkeys.some((w) => w.deviceId === here);
  const ways = proofWays(keys, prf);
  const toggle = (next: PrivacyStep): void => on.ask(step === next ? "idle" : next);
  return (
    <div className="privacy-rows">
      <div className="account-row-title">Devices</div>
      {devices.map((d) => (
        <div className="account-row privacy-device-row" key={d.id}>
          <span className="account-row-title">
            {d.label}
            {d.id === here && <span className="privacy-tag">This device</span>}
            <span className="account-row-note">Added {addedOn(d.createdAt)}</span>
          </span>
          <button type="button" className="row-action quiet" disabled={busy} onClick={() => on.remove(d.id)}>Remove</button>
        </div>
      ))}
      <div className="account-row">
        <span className="account-row-title">
          Face ID or fingerprint
          {passkeys.length > 0 && <span className="account-row-note">{passkeyHere ? "Set up on this device" : "Set up on another device"}</span>}
        </span>
        {prf && here !== null && !passkeyHere && (
          <button type="button" className="row-action" disabled={busy} onClick={() => toggle("passkey")}>Add on this device</button>
        )}
      </div>
      {step === "passkey" && <ProofForm ways={ways} disabled={false} busy={busy} problem={problem} onProve={(way) => on.prove(way)} />}
      <div className="account-row">
        <span className="account-row-title">Vault password</span>
        <button type="button" className="row-action" disabled={busy} onClick={() => toggle("password")}>{hasPassword ? "Change" : "Add"}</button>
      </div>
      {step === "password" && <NewPasswordForm ways={ways} busy={busy} problem={problem} onProve={on.prove} />}
      <div className="account-row">
        <span className="account-row-title">Recovery key</span>
        <button type="button" className="row-action" disabled={busy} onClick={() => toggle("recovery")}>Make a new one</button>
      </div>
      {step === "recovery" && <ProofForm ways={ways} disabled={false} busy={busy} problem={problem} onProve={(way) => on.prove(way)} />}
      {step === "idle" && problem !== null && <span className="account-row-note" role="alert">{problem}</span>}
    </div>
  );
}

/**
 * Account > Privacy and security as a whole: where this copy keeps data, the key rows, then the
 * App lock row. Pure. The line is left out until it is known whether the viewer is the owner.
 */
export function PrivacySection({ owner, local = false, appLock, encryption = null, children }: {
  readonly owner: boolean | null;
  /** Set only by the local-mode phase. */
  readonly local?: boolean;
  readonly appLock: ReactNode;
  /** The full-account encryption row, after the App lock row. */
  readonly encryption?: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <div className="privacy-section">
      {owner !== null && <p className="account-row-note privacy-home">{dataHome({ owner, local })}</p>}
      {children}
      {appLock}
      {encryption}
    </div>
  );
}

type Shown =
  | { readonly at: "rows" }
  | { readonly at: "setup" }
  | { readonly at: "recovery"; readonly pending: PendingRecovery };

/** Account > Privacy and security: the key's rows. Locked notes adds the rest beside them. */
export function AccountPrivacy({ email, owner = null }: { readonly email: string | null; readonly owner?: boolean | null }) {
  const vault = useVault();
  const ways = useMemo(() => (email === null ? null : keyWays(email)), [email]);
  const prf = useMemo(() => prfPossible(), []);
  const [keys, setKeys] = useState<KeyState | null>(null);
  const [here, setHere] = useState<string | null>(null);
  const [shown, setShown] = useState<Shown>({ at: "rows" });
  const [step, setStep] = useState<PrivacyStep>("idle");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  // Opened on this visit, so a browser that cannot keep the key still shows the rows once it is open.
  const [openedNow, setOpenedNow] = useState(false);
  // A pairing link this page was opened with, from a new device asking to be let in.
  const [pair, setPair] = useState(landedPair);
  const [allowing, setAllowing] = useState(false);

  const load = useCallback(async (): Promise<void> => {
    if (ways === null) return;
    try {
      await ways.checkDevice();
      setHere((await ways.held())?.deviceId ?? null);
      setKeys(await keysNow());
    } catch (error) {
      setProblem(sentence(error));
    }
  }, [ways]);
  useEffect(() => { void load(); }, [load]);

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

  if (ways === null) {
    return (
      <PrivacySection owner={owner} local={isLocal()} appLock={null}>
        <PrivacyRows keys={null} here={null} prf={prf} step="idle" busy={false} problem={null} on={{ setUp: () => undefined, remove: () => undefined, ask: () => undefined, prove: () => undefined }} />
      </PrivacySection>
    );
  }

  if (shown.at === "setup") {
    return (
      <KeySetup prepare={(way) => ways.prepareSetUp(way)} prf={prf}
        onSaved={(opened) => { setShown({ at: "rows" }); setOpenedNow(true); keyReady(vault, opened, () => void load()); }} />
    );
  }
  if (shown.at === "recovery") {
    const pending = shown.pending;
    return (
      <RecoveryKey recoveryKey={pending.recoveryKey} busy={busy} problem={problem}
        onDone={() => void run(async () => { await pending.save(); setShown({ at: "rows" }); setStep("idle"); await load(); })} />
    );
  }

  if (keys !== null && keys.keyRef !== null && here === null && !openedNow) {
    return (
      <KeyUnlock ways={ways} keys={keys} prf={prf} email={email} origin={window.location.origin}
        onOpened={(opened: Opened) => { setOpenedNow(true); keyReady(vault, opened, () => void load()); }} />
    );
  }

  const approve = pair !== null && keys !== null && keys.keyRef !== null && (
    <PairApprove ways={proofWays(keys, prf)} asking={allowing} busy={busy} problem={problem}
      onAllow={() => { setProblem(null); setAllowing(true); }}
      onNotNow={() => { clearLandedPair(); setPair(null); setAllowing(false); setProblem(null); }}
      onProve={(way) => void run(async () => {
        await ways.allowPairing(way, pair.id, pair.publicPart);
        clearLandedPair();
        setPair(null);
        setAllowing(false);
      })} />
  );

  const on: PrivacyHandlers = {
    setUp: () => { setProblem(null); setShown({ at: "setup" }); },
    ask: (next) => { setProblem(null); setStep(next); },
    remove: (id) => void run(async () => { await ways.removeWay(id); await load(); }),
    prove: (way, newPassword) => void run(async () => {
      if (step === "passkey") {
        await ways.addWay({ kind: "passkey" }, way);
      } else if (step === "password" && newPassword !== undefined) {
        await ways.addWay({ kind: "password", password: newPassword }, way);
      } else if (step === "recovery") {
        setShown({ at: "recovery", pending: await ways.newRecoveryKey(way) });
        return;
      }
      setStep("idle");
      await load();
    }),
  };
  return (
    <PrivacySection owner={owner} local={isLocal()}
      encryption={email !== null && (
        <AccountEncryption ways={ways} keys={keys} prf={prf} onKeySaved={(opened) => keyReady(vault, opened, () => void load())} />
      )}
      // Not drawn until the key rows have answered: before that this device cannot say whether the account has a key,
      // and a press would start setting a second one up.
      appLock={email !== null && keys !== null && (
        <AppLockRow account={email} hasKey={keys !== null && keys.keyRef !== null} prf={prf}
          prepare={(way) => ways.prepareSetUp(way)} onKeySaved={(opened) => keyReady(vault, opened, () => void load())} />
      )}>
      {approve}
      <PrivacyRows keys={keys} here={here} prf={prf} step={step} busy={busy} problem={allowing ? null : problem} on={on} />
    </PrivacySection>
  );
}
