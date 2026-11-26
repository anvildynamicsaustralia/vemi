import { useEffect, useState } from "react";
import { countdown } from "../moveCountdown.js";
import "./privacy.css";

/**
 * A move code an account made: the code in a mono box, Copy, and the time it has left. When
 * the time is up the code is gone and so is Copy. `now` is for tests; the screen reads the clock.
 */
export function MoveCode({ code, expiresAt, now }: {
  readonly code: string;
  readonly expiresAt: string;
  readonly now?: number;
}) {
  const [clock, setClock] = useState(() => now ?? Date.now());
  const [copied, setCopied] = useState(false);
  const end = Date.parse(expiresAt);
  const left = end - (now ?? clock);
  const live = left > 0;

  useEffect(() => {
    if (now !== undefined || !live) return;
    const tick = setInterval(() => setClock(Date.now()), 1000);
    return () => clearInterval(tick);
  }, [now, live]);

  const copy = (): void => {
    void navigator.clipboard?.writeText(code).then(() => setCopied(true), () => undefined);
  };
  return (
    <div className="account-form move-code">
      <code className="key-text move-code-text">{code}</code>
      <div className="recovery-key-actions">
        {live && <button type="button" className="row-action" onClick={copy}>{copied ? "Copied" : "Copy"}</button>}
        <span className="account-row-note" role="timer">{live ? countdown(end, now ?? clock) : "Expired"}</span>
      </div>
    </div>
  );
}
