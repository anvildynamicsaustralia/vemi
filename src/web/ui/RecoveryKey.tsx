import { useState } from "react";
import "./privacy.css";

/** The last group of a formatted recovery key, the one the person types back before anything is saved. */
export function lastGroup(recoveryKey: string): string {
  return recoveryKey.split("-").pop() ?? "";
}

const clean = (text: string): string => text.toUpperCase().replace(/[\s-]+/g, "").replace(/[IL]/g, "1").replace(/O/g, "0");

/** Whether what was typed is the key's last group (case, spaces and look-alike letters do not matter). */
export function lastGroupMatches(recoveryKey: string, typed: string): boolean {
  const want = clean(lastGroup(recoveryKey));
  return want !== "" && clean(typed) === want;
}

/** The text of the saved file: the key and the day it was made. */
export function recoveryFileText(recoveryKey: string, day: string): string {
  return `VEMI recovery key\n\n${recoveryKey}\n\nMade ${day}\n`;
}

export const RECOVERY_FILE = "vemi-recovery-key.txt";

function saveAsFile(recoveryKey: string): void {
  const day = new Date().toISOString().slice(0, 10);
  const url = URL.createObjectURL(new Blob([recoveryFileText(recoveryKey, day)], { type: "text/plain" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = RECOVERY_FILE;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

/**
 * The recovery key, shown once. Copy, Save as file and Print give the person somewhere to keep it;
 * Done stays off until the last group has been typed back, so nothing is saved for a key they never had.
 */
export function RecoveryKey({ recoveryKey, busy, problem, onDone }: {
  readonly recoveryKey: string;
  readonly busy: boolean;
  readonly problem: string | null;
  readonly onDone: () => void;
}) {
  const [typed, setTyped] = useState("");
  const [copied, setCopied] = useState(false);
  const matches = lastGroupMatches(recoveryKey, typed);
  const copy = (): void => {
    void navigator.clipboard?.writeText(recoveryKey).then(() => setCopied(true), () => undefined);
  };
  return (
    <div className="account-form recovery-key">
      <code className="key-text recovery-key-text">{recoveryKey}</code>
      <span className="account-row-note">Shown once.</span>
      <div className="recovery-key-actions">
        <button type="button" className="row-action" onClick={copy}>{copied ? "Copied" : "Copy"}</button>
        <button type="button" className="row-action" onClick={() => saveAsFile(recoveryKey)}>Save as file</button>
        <button type="button" className="row-action" onClick={() => window.print()}>Print</button>
      </div>
      <input className="field" type="text" autoComplete="off" autoCapitalize="characters" spellCheck={false}
        placeholder="Last group" aria-label="Last group" value={typed} onChange={(e) => setTyped(e.target.value)} />
      {problem !== null && <span className="account-row-note" role="alert">{problem}</span>}
      <button type="button" className="primary-button" disabled={busy || !matches} onClick={onDone}>Done</button>
      <div className="recovery-print" aria-hidden="true">{recoveryKey}</div>
    </div>
  );
}
