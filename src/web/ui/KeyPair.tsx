import { useEffect, useMemo, useRef, useState } from "react";
import { qrMatrix, qrSvg } from "@vemi/shared";
import type { KeyRow, KeyState } from "../api.js";
import type { OpenWay, Opened, PairingHandle } from "../keyWays.js";
import { pairLink } from "../pairLink.js";
import "./privacy.css";

const sentence = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** The ways in that can open the key now, from the rows the Worker lists and what this device can do. */
export function proofWays(keys: KeyState, prf: boolean): { readonly passkey: boolean; readonly password: boolean; readonly recovery: boolean } {
  const live = (kind: KeyRow["kind"]): boolean => keys.wraps.some((w) => w.kind === kind);
  return { passkey: prf && live("passkey"), password: live("password"), recovery: live("recovery") };
}

/** Asks for one way in, because a new wrapping or a shared key needs the whole key. */
export function ProofForm({ ways, disabled, busy, problem, onProve }: {
  readonly ways: ReturnType<typeof proofWays>;
  readonly disabled: boolean;
  readonly busy: boolean;
  readonly problem: string | null;
  readonly onProve: (way: OpenWay) => void;
}) {
  const [password, setPassword] = useState("");
  const [recoveryKey, setRecoveryKey] = useState("");
  return (
    <div className="account-form privacy-ways">
      {ways.passkey && (
        <button type="button" className="row-action" disabled={disabled || busy} onClick={() => onProve({ kind: "passkey" })}>Face ID or fingerprint</button>
      )}
      {ways.password && (
        <form className="account-form" onSubmit={(e) => { e.preventDefault(); if (!disabled && !busy && password !== "") onProve({ kind: "password", password }); }}>
          <input className="field" type="password" autoComplete="current-password" placeholder="Vault password" aria-label="Vault password to open the key"
            value={password} onChange={(e) => setPassword(e.target.value)} />
          <button type="submit" className="primary-button" disabled={disabled || busy || password === ""}>Use vault password</button>
        </form>
      )}
      {ways.recovery && (
        <form className="account-form" onSubmit={(e) => { e.preventDefault(); if (!disabled && !busy && recoveryKey !== "") onProve({ kind: "recovery", recoveryKey }); }}>
          <input className="field" type="text" autoComplete="off" spellCheck={false} placeholder="Recovery key" aria-label="Recovery key to open the key"
            value={recoveryKey} onChange={(e) => setRecoveryKey(e.target.value)} />
          <button type="submit" className="primary-button" disabled={disabled || busy || recoveryKey === ""}>Use recovery key</button>
        </form>
      )}
      {problem !== null && <span className="account-row-note" role="alert">{problem}</span>}
    </div>
  );
}

/** An SVG of `link` as a QR code, or null when it does not fit. */
export function qrFor(link: string): string | null {
  try {
    return qrSvg(qrMatrix(link));
  } catch {
    return null;
  }
}

/** The new device's side: the QR, the same link to copy, and the wait. Pure. */
export function PairView({ link, qr, copied, problem, onCopy, onAgain, onBack }: {
  /** Null while the pairing is being opened. */
  readonly link: string | null;
  readonly qr: string | null;
  readonly copied: boolean;
  readonly problem: string | null;
  readonly onCopy: () => void;
  readonly onAgain: () => void;
  readonly onBack: () => void;
}) {
  return (
    <div className="account-form key-pair">
      {problem !== null ? (
        <>
          <span className="account-row-note" role="alert">{problem}</span>
          <button type="button" className="primary-button" onClick={onAgain}>Try again</button>
        </>
      ) : link === null ? (
        <span className="account-row-note">Getting ready</span>
      ) : (
        <>
          {qr !== null && <div className="qr" role="img" aria-label="QR code to open on a device that has the key" dangerouslySetInnerHTML={{ __html: qr }} />}
          <code className="key-text pair-link">{link}</code>
          <div className="recovery-key-actions">
            <button type="button" className="row-action" onClick={onCopy}>{copied ? "Copied" : "Copy"}</button>
          </div>
          <span className="account-row-note">Waiting for the other device</span>
        </>
      )}
      <button type="button" className="row-action quiet" onClick={onBack}>Back</button>
    </div>
  );
}

/** What the pairing needs from the key's orchestration. */
export interface PairWays {
  startPairing(): Promise<PairingHandle>;
  finishPairing(handle: PairingHandle): Promise<Opened | null>;
}

export const POLL_MS = 2000;
export const POLL_LIMIT_MS = 10 * 60 * 1000;
const TOO_LONG = "That took too long.";

/**
 * The new device: opens a pairing, shows its link and QR, and asks the Worker every 2 seconds for
 * at most 10 minutes whether a device that holds the key has answered. The key is checked, kept
 * and this device listed by `finishPairing`.
 */
export function KeyPair({ ways, origin, onOpened, onBack, pollMs = POLL_MS, limitMs = POLL_LIMIT_MS }: {
  readonly ways: PairWays;
  readonly origin: string;
  readonly onOpened: (opened: Opened) => void;
  readonly onBack: () => void;
  readonly pollMs?: number;
  readonly limitMs?: number;
}) {
  const [attempt, setAttempt] = useState(0);
  const [link, setLink] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  // The latest handler is read when it is called; a new function each draw must not restart the wait.
  const finished = useRef(onOpened);
  finished.current = onOpened;
  const qr = useMemo(() => (link === null ? null : qrFor(link)), [link]);

  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    setLink(null);
    setProblem(null);
    setCopied(false);
    void (async () => {
      try {
        const handle = await ways.startPairing();
        if (!live) return;
        setLink(pairLink(origin, { id: handle.id, publicPart: handle.publicPart }));
        const until = Date.now() + limitMs;
        const poll = async (): Promise<void> => {
          if (!live) return;
          try {
            const opened = await ways.finishPairing(handle);
            if (!live) return;
            if (opened !== null) {
              finished.current(opened);
              return;
            }
          } catch (error) {
            if (live) setProblem(sentence(error));
            return;
          }
          if (Date.now() >= until) {
            if (live) setProblem(TOO_LONG);
            return;
          }
          timer = setTimeout(() => void poll(), pollMs);
        };
        timer = setTimeout(() => void poll(), pollMs);
      } catch (error) {
        if (live) setProblem(sentence(error));
      }
    })();
    return () => {
      live = false;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [ways, origin, attempt, pollMs, limitMs]);

  const copy = (): void => {
    if (link === null) return;
    void navigator.clipboard?.writeText(link).then(() => setCopied(true), () => undefined);
  };
  return <PairView link={link} qr={qr} copied={copied} problem={problem} onCopy={copy} onAgain={() => setAttempt((n) => n + 1)} onBack={onBack} />;
}

/** The device that holds the key: asked whether to let the device behind a link open locked things. Pure. */
export function PairApprove({ ways, asking, busy, problem, onAllow, onNotNow, onProve }: {
  readonly ways: ReturnType<typeof proofWays>;
  /** True once Allow was pressed and one way in is wanted. */
  readonly asking: boolean;
  readonly busy: boolean;
  readonly problem: string | null;
  readonly onAllow: () => void;
  readonly onNotNow: () => void;
  readonly onProve: (way: OpenWay) => void;
}) {
  return (
    <div className="account-form pair-approve">
      <span className="account-row-title">Let a new device open locked things?</span>
      {!asking ? (
        <div className="recovery-key-actions">
          <button type="button" className="primary-button" disabled={busy} onClick={onAllow}>Allow</button>
          <button type="button" className="row-action" disabled={busy} onClick={onNotNow}>Not now</button>
        </div>
      ) : (
        <>
          <ProofForm ways={ways} disabled={false} busy={busy} problem={problem} onProve={onProve} />
          <button type="button" className="row-action quiet" disabled={busy} onClick={onNotNow}>Not now</button>
        </>
      )}
      {!asking && problem !== null && <span className="account-row-note" role="alert">{problem}</span>}
    </div>
  );
}
