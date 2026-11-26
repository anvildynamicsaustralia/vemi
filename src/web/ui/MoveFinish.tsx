import { useState, type ReactElement } from "react";
import { prfPossible } from "../passkeyPrf.js";
import type { OpenWay } from "../keyWays.js";
import {
  FINISHING, clearFinishing, finishLocked, idsFromCopy, lockedHeld, markFinishing, openBeforeSend, passkeyLine, type LockedHeld,
} from "../moveLocked.js";
import type { ResealSteps } from "../restoreReseal.js";
import { ProofForm, proofWays } from "./KeyPair.js";

export type FinishPhase =
  | { readonly kind: "ask" }
  | { readonly kind: "working" }
  | { readonly kind: "done"; readonly resealed: number; readonly left: number; readonly said: string | null }
  | { readonly kind: "bad"; readonly reason: string };

/** The finishing pass as the person sees it. Drawn from a phase, so every state can be seen without running a move. */
export function MoveFinishView({ held, phase, onProve }: {
  readonly held: LockedHeld;
  readonly phase: FinishPhase;
  readonly onProve: (way: OpenWay) => void;
}): ReactElement {
  const line = passkeyLine(held);
  return (
    <section className="account-form move-finish" aria-label={FINISHING}>
      <p className="account-row-title">{FINISHING}</p>
      {(phase.kind === "ask" || phase.kind === "bad") && held.keys !== null && (
        <ProofForm
          ways={proofWays(held.keys, prfPossible())}
          disabled={false}
          busy={false}
          problem={phase.kind === "bad" ? phase.reason : null}
          onProve={onProve}
        />
      )}
      {phase.kind === "working" && <p className="account-row-note" role="status">{FINISHING}</p>}
      {phase.kind === "done" && phase.said !== null && <p className="account-row-note" role="status">{phase.said}</p>}
      {phase.kind === "done" && line !== null && <p className="account-row-note">{line}</p>}
    </section>
  );
}

/**
 * Runs on the new copy once the person is signed in to it. `document` is the file they moved (its
 * envelopes and key rows); `ids` is the answer's old-to-new map when this page still holds it, and
 * is read back from the new copy's own rows (`loadCopy`) when it does not, so a closed tab resumes.
 */
export function MoveFinish({ account, document, ids, loadCopy, steps, onFinished }: {
  readonly account: string;
  readonly document: Readonly<Record<string, unknown>>;
  readonly ids?: Readonly<Record<string, string>>;
  readonly loadCopy: () => Promise<Readonly<Record<string, unknown>>>;
  readonly steps: ResealSteps;
  readonly onFinished?: (result: { readonly resealed: number; readonly left: number }) => void;
}): ReactElement | null {
  const held = lockedHeld(document);
  const [phase, setPhase] = useState<FinishPhase>({ kind: "ask" });
  if (held.locked + held.typed === 0) return null;

  const prove = (way: OpenWay): void => {
    setPhase({ kind: "working" });
    void (async () => {
      try {
        const key = await openBeforeSend(account, document, way);
        const map = ids ?? idsFromCopy(document, await loadCopy());
        markFinishing(map);
        const done = await finishLocked(document, map, key, steps);
        clearFinishing();
        setPhase({ kind: "done", resealed: done.resealed, left: done.left, said: done.said });
        onFinished?.({ resealed: done.resealed, left: done.left });
      } catch (err) {
        setPhase({ kind: "bad", reason: err instanceof Error ? err.message : "That did not open the key." });
      }
    })();
  };
  return <MoveFinishView held={held} phase={phase} onProve={prove} />;
}
