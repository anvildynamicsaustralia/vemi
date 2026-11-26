import { useState, type ReactElement } from "react";
import { wipeNow } from "../local/parts.js";
import type { WipeResult } from "../local/wipe.js";

export type ClearPhase =
  | { readonly kind: "ask" }
  | { readonly kind: "working" }
  | { readonly kind: "done"; readonly said: string }
  | { readonly kind: "bad"; readonly reason: string };

/** The banner as the person sees it: one tap on Clear this device, and what it did. */
export function ClearDeviceView({ phase, onClear }: { readonly phase: ClearPhase; readonly onClear: () => void }): ReactElement {
  return (
    <div className="account-row" role="status">
      {phase.kind === "done" ? (
        <span className="account-row-title">{phase.said}</span>
      ) : (
        <>
          <span className="account-row-title">
            Your new copy has your things.
            {phase.kind === "bad" && <span className="account-row-note">{phase.reason}</span>}
          </span>
          <span className="account-row-actions">
            <button type="button" className="row-action" disabled={phase.kind === "working"} onClick={onClear}>Clear this device</button>
          </span>
        </>
      )}
    </div>
  );
}

/**
 * The banner in local mode after a move. Nothing clears until the tap; a failed clear changes
 * nothing. `wipe` is replaced in tests, and `onCleared` is what runs after, by default a reload,
 * because the page was drawn from the data that is gone.
 */
export function ClearDevice({ wipe = wipeNow, onCleared }: {
  readonly wipe?: () => Promise<WipeResult>;
  readonly onCleared?: () => void;
}): ReactElement {
  const [phase, setPhase] = useState<ClearPhase>({ kind: "ask" });
  const clear = (): void => {
    setPhase({ kind: "working" });
    void wipe().then(
      (result) => {
        if (!result.ok) return setPhase({ kind: "bad", reason: result.reason });
        setPhase({ kind: "done", said: result.said });
        window.setTimeout(onCleared ?? (() => window.location.reload()), 2500);
      },
      () => setPhase({ kind: "bad", reason: "Something went wrong, so nothing was cleared." }),
    );
  };
  return <ClearDeviceView phase={phase} onClear={clear} />;
}
