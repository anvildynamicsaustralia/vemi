import { useEffect, useState } from "react";
import { PASSWORD_MIN, passwordLength, qrMatrix, qrSvg } from "@vemi/shared";
import { paths, read, saveTimeZone } from "../api.js";
import {
  changePassword, googleStart, newRecoveryCode, signOutEverywhere, twoStepOff, twoStepSetup, twoStepVerify, unlinkGoogle,
} from "../auth.js";
import type { Me, TwoStepKey } from "../auth.js";
import { discardsWaiting } from "../signOutWords.js";
import { browserZone, knownZones, zoneChoices, zoneShown } from "../zoneChoices.js";
import "./accountProfile.css";
import { useApp } from "./appContext.js";

type Where = "password" | "google" | "everywhere" | "twoStep" | "recovery" | "zone";

/** Where 2-step setup is: not started, showing the key, showing the backup codes once, or asking the password to turn off. */
type TwoStepView =
  | { readonly at: "idle" }
  | { readonly at: "setup"; readonly key: TwoStepKey; readonly svg: string }
  | { readonly at: "codes"; readonly codes: readonly string[] }
  | { readonly at: "off" };

/** Where the recovery code is: not asked for, asking the password, or showing the new one once. */
type RecoveryView = { readonly at: "idle" } | { readonly at: "ask" } | { readonly at: "shown"; readonly code: string };

/** Account > Profile and sign-in: the password, Google, other devices, and this device. */
export function AccountProfile({ who, asked, waiting, onClose, onSignOut, refresh }: {
  readonly who: Me | null;
  /** Whether the Worker has answered yet; until it has, the rows that wait on it hold their place. */
  readonly asked: boolean;
  readonly waiting: number;
  readonly onClose: () => void;
  readonly onSignOut: () => Promise<void>;
  readonly refresh: () => Promise<void>;
}) {
  const app = useApp();
  const [busy, setBusy] = useState(false);
  const [passwordForm, setPasswordForm] = useState(false);
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [again, setAgain] = useState("");
  // A refusal shows by the form or row that met it, not at the foot of the panel.
  const [problem, setProblem] = useState<{ readonly where: Where; readonly text: string } | null>(null);
  // Sign out was pressed with changes still waiting, and is asking first.
  const [confirming, setConfirming] = useState(false);
  const hasPassword = who?.password === true;
  const [twoStep, setTwoStep] = useState<TwoStepView>({ at: "idle" });
  const [recovery, setRecovery] = useState<RecoveryView>({ at: "idle" });
  // The password a row asks for, and the code from the app, each kept only while its form is open.
  const [proof, setProof] = useState("");
  const [code, setCode] = useState("");
  // The zone the account saved, or null for none; undefined until the Worker has said.
  const [savedZone, setSavedZone] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    read<{ readonly timeZone?: string | null }>(paths.appearance)
      .then((r) => { if (live) setSavedZone(r.data.timeZone ?? null); })
      .catch(() => undefined);
    return () => { live = false; };
  }, []);

  /** Runs one account action. A refusal shows next to `where`, the form or row it came from. */
  const attempt = async (where: Where, work: () => Promise<void>): Promise<void> => {
    setBusy(true);
    setProblem(null);
    try {
      await work();
    } catch (err) {
      setProblem({ where, text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  };

  const mismatch = next !== "" && again !== "" && next !== again;
  // Said before the Worker would refuse it. The Worker is still the one that checks.
  const tooShort = passwordLength(next) < PASSWORD_MIN;
  /** The refusal that belongs here, or nothing. */
  const problemAt = (where: Where) => problem?.where === where && <div className="error" role="alert">{problem.text}</div>;
  const savePassword = (): Promise<void> => attempt("password", async () => {
    await changePassword(hasPassword ? current : "", next);
    setPasswordForm(false);
    setCurrent("");
    setNext("");
    setAgain("");
    app.notify(hasPassword ? "Password changed. Other devices are signed out." : "Password set.");
    await refresh();
  });

  const closeProof = (): void => { setProof(""); setCode(""); setProblem(null); };
  const startSetup = (): Promise<void> => attempt("twoStep", async () => {
    const key = await twoStepSetup();
    setCode("");
    setTwoStep({ at: "setup", key, svg: qrSvg(qrMatrix(key.uri)) });
  });
  const finishSetup = (): Promise<void> => attempt("twoStep", async () => {
    const codes = await twoStepVerify(code.trim());
    setCode("");
    setTwoStep({ at: "codes", codes });
    await refresh();
  });
  const turnOff = (): Promise<void> => attempt("twoStep", async () => {
    await twoStepOff(proof);
    closeProof();
    setTwoStep({ at: "idle" });
    app.notify("2-step is off.");
    await refresh();
  });
  const newRecovery = (): Promise<void> => attempt("recovery", async () => {
    const fresh = await newRecoveryCode(proof);
    closeProof();
    setRecovery({ at: "shown", code: fresh });
  });
  const chooseZone = (zone: string): Promise<void> => attempt("zone", async () => {
    await saveTimeZone(zone);
    setSavedZone(zone);
  });
  const shownZone = zoneShown(savedZone ?? null, browserZone());

  const everywhere = (): Promise<void> => attempt("everywhere", async () => {
    await signOutEverywhere();
    app.notify("Signed out everywhere else. This device stays signed in.");
  });

  /** Changes still waiting are lost by signing out, so the first press says how many. */
  const leave = async (): Promise<void> => {
    if (waiting > 0 && !confirming) {
      setConfirming(true);
      return;
    }
    setBusy(true);
    onClose();
    await onSignOut();
  };

  // Its title is what it reaches, so the row does not say its button's words twice.
  const otherDevices = (
    <span className="account-row-title">
      Other devices
      <span className="account-row-note">Signs out every device but this one, which stays signed in.</span>
    </span>
  );

  return (
    <div className="account-rows">
      {waiting > 0 && (
        <div className="account-row">
          <span className="account-row-title">{waiting} {waiting === 1 ? "change" : "changes"} waiting to send</span>
        </div>
      )}
      {who === null && !asked && (
        <>
          <div className="account-row">
            <span className="account-row-title">Password</span>
            <button type="button" className="row-action" disabled>Set</button>
          </div>
          <div className="account-row">
            <span className="account-row-title">Google</span>
            <button type="button" className="row-action" disabled>Link</button>
          </div>
          <div className="account-row">
            {otherDevices}
            <button type="button" className="row-action" disabled>Sign out everywhere</button>
          </div>
        </>
      )}
      {who !== null && (
        <>
          <div className="account-row">
            <span className="account-row-title">Password</span>
            <button type="button" className="row-action" disabled={busy} onClick={() => { setPasswordForm(!passwordForm); setProblem(null); }}>
              {hasPassword ? "Change" : "Set"}
            </button>
          </div>
          {passwordForm && (
            <form className="account-form" onSubmit={(e) => { e.preventDefault(); if (!busy && !mismatch && !tooShort) void savePassword(); }}>
              {hasPassword && (
                <input className="field" type="password" autoComplete="current-password" placeholder="Current password" aria-label="Current password"
                  value={current} onChange={(e) => setCurrent(e.target.value)} />
              )}
              <input className="field" type="password" autoComplete="new-password" placeholder="New password" aria-label="New password"
                value={next} onChange={(e) => setNext(e.target.value)} />
              <input className="field" type="password" autoComplete="new-password" placeholder="New password again" aria-label="New password again"
                value={again} onChange={(e) => setAgain(e.target.value)} />
              <span className="account-row-note">{mismatch ? "The two passwords are not the same." : `At least ${PASSWORD_MIN} characters.`}</span>
              {problemAt("password")}
              <button type="submit" className="primary-button"
                disabled={busy || mismatch || tooShort || again === "" || (hasPassword && current === "")}>
                {hasPassword ? "Change password" : "Set password"}
              </button>
            </form>
          )}
          {/* Only where the copy has Google keys, or where this account already linked one. */}
          {(who.googleReady || who.google === true) && (
            <div className="account-row">
              <span className="account-row-title">
                Google
                {who.google === true && !hasPassword && (
                  <span className="account-row-note">Set a password first, so there is still a way in.</span>
                )}
              </span>
              {who.google === true
                ? (
                  <button type="button" className="row-action" disabled={busy || !hasPassword}
                    onClick={() => void attempt("google", async () => { await unlinkGoogle(); app.notify("Google unlinked."); await refresh(); })}>Unlink</button>
                )
                : (
                  <button type="button" className="row-action" disabled={busy}
                    onClick={() => void attempt("google", () => googleStart("link"))}>Link</button>
                )}
            </div>
          )}
          {problemAt("google")}
          {hasPassword && (
            <>
              <div className="account-row">
                <span className="account-row-title">
                  2-step sign-in
                  <span className="account-row-note">{who.twoStep === true ? "On. Sign-in asks for a code from your authenticator app." : "Off."}</span>
                </span>
                {who.twoStep === true
                  ? (
                    <button type="button" className="row-action" disabled={busy}
                      onClick={() => { closeProof(); setTwoStep(twoStep.at === "off" ? { at: "idle" } : { at: "off" }); }}>Turn off</button>
                  )
                  : <button type="button" className="row-action" disabled={busy} onClick={() => void startSetup()}>Set up</button>}
              </div>
              {twoStep.at === "setup" && (
                <form className="account-form" onSubmit={(e) => { e.preventDefault(); if (!busy && code.trim() !== "") void finishSetup(); }}>
                  <div className="qr" role="img" aria-label="QR code for your authenticator app" dangerouslySetInnerHTML={{ __html: twoStep.svg }} />
                  <span className="account-row-note">Key</span>
                  <code className="key-text">{twoStep.key.secret}</code>
                  <input className="field" inputMode="numeric" autoComplete="one-time-code" placeholder="6-digit code" aria-label="6-digit code"
                    value={code} onChange={(e) => setCode(e.target.value)} />
                  {problemAt("twoStep")}
                  <button type="submit" className="primary-button" disabled={busy || code.trim() === ""}>Turn on</button>
                </form>
              )}
              {twoStep.at === "codes" && (
                <div className="account-form">
                  <span className="account-row-title">Backup codes</span>
                  <ul className="code-list">{twoStep.codes.map((c) => <li key={c}><code>{c}</code></li>)}</ul>
                  <span className="account-row-note">Each works once, and they are not shown again.</span>
                  <button type="button" className="primary-button" onClick={() => setTwoStep({ at: "idle" })}>Done</button>
                </div>
              )}
              {twoStep.at === "off" && (
                <form className="account-form" onSubmit={(e) => { e.preventDefault(); if (!busy && proof !== "") void turnOff(); }}>
                  <input className="field" type="password" autoComplete="current-password" placeholder="Password" aria-label="Password"
                    value={proof} onChange={(e) => setProof(e.target.value)} />
                  {problemAt("twoStep")}
                  <button type="submit" className="primary-button" disabled={busy || proof === ""}>Turn off 2-step</button>
                </form>
              )}
              {twoStep.at === "idle" && problemAt("twoStep")}
              <div className="account-row">
                <span className="account-row-title">
                  Recovery code
                  <span className="account-row-note">Gets you back in without your password. A new one replaces the old.</span>
                </span>
                <button type="button" className="row-action" disabled={busy}
                  onClick={() => { closeProof(); setRecovery(recovery.at === "ask" ? { at: "idle" } : { at: "ask" }); }}>New code</button>
              </div>
              {recovery.at === "ask" && (
                <form className="account-form" onSubmit={(e) => { e.preventDefault(); if (!busy && proof !== "") void newRecovery(); }}>
                  <input className="field" type="password" autoComplete="current-password" placeholder="Password" aria-label="Password"
                    value={proof} onChange={(e) => setProof(e.target.value)} />
                  {problemAt("recovery")}
                  <button type="submit" className="primary-button" disabled={busy || proof === ""}>Make a new code</button>
                </form>
              )}
              {recovery.at === "shown" && (
                <div className="account-form">
                  <code className="key-text">{recovery.code}</code>
                  <span className="account-row-note">Shown once. The old code no longer works.</span>
                  <button type="button" className="primary-button" onClick={() => setRecovery({ at: "idle" })}>Done</button>
                </div>
              )}
            </>
          )}
          <div className="account-row">
            <span className="account-row-title">Time zone</span>
            <select className="field zone-field" aria-label="Time zone" value={shownZone} disabled={busy || savedZone === undefined}
              onChange={(e) => void chooseZone(e.target.value)}>
              {zoneChoices(knownZones(), shownZone).map((z) => <option key={z} value={z}>{z}</option>)}
            </select>
          </div>
          {problemAt("zone")}
          <div className="account-row">
            {otherDevices}
            <button type="button" className="row-action" disabled={busy} onClick={() => void everywhere()}>Sign out everywhere</button>
          </div>
          {problemAt("everywhere")}
        </>
      )}
      <div className="account-row">
        <span className="account-row-title">
          This device
          <span className="account-row-note">
            {confirming && waiting > 0 ? discardsWaiting(waiting) : "Signs out here and forgets everything this device kept."}
          </span>
        </span>
        {confirming && waiting > 0
          ? (
            <span className="account-row-actions">
              <button type="button" className="row-action" disabled={busy} onClick={() => setConfirming(false)}>Cancel</button>
              <button type="button" className="row-action" disabled={busy} onClick={() => void leave()}>Sign out anyway</button>
            </span>
          )
          : <button type="button" className="row-action" disabled={busy} onClick={() => void leave()}>Sign out</button>}
      </div>
    </div>
  );
}
