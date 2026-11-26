import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { type LockableField, type LockableKind, isSealed } from "@vemi/shared";
import { type KeyState, keysNow } from "../api.js";
import { markTipSeen } from "../firstRunState.js";
import { type OpenWay, type Opened, keyWays } from "../keyWays.js";
import { prfPossible } from "../passkeyPrf.js";
import type { Outcome } from "../outcome.js";
import { ProofForm, proofWays } from "./KeyPair.js";
import { KeySetup } from "./KeySetup.js";
import { KeyUnlock } from "./KeyUnlock.js";
import { LockIcon, LockedBlock } from "./LockedBlock.js";
import { Tip } from "./Tip.js";
import { useVault } from "./vaultContext.js";
import "./lockable.css";

/** What an editor hands back: the text typed, and the text that was on screen before it. */
export type SaveText = (next: string, was: string | null) => Promise<Outcome | boolean> | void;

/** What the field shows: ordinary text, a locked field this device can read, or one it cannot. */
export type LockPhase =
  | { readonly at: "plain"; readonly text: string | null }
  | { readonly at: "open"; readonly text: string }
  | { readonly at: "closed" }
  | { readonly at: "damaged" }
  | { readonly at: "reading" };

/** Which way in is on screen, in place of the editor. */
export type LockPanel = "setup" | "unlock" | "prove";

/**
 * The drawing of one lockable field, with nothing of its own to remember. `editor` is the wrapped
 * editor; `panel` is a way in brought up in place; `tip` is the lock tip. Pure.
 */
export function LockableView({ phase, editor, panel, tip, problem = null, busy = false, canLock = true, onLock, onUnlock, onOpen, onCancel }: {
  readonly phase: LockPhase;
  readonly editor: ReactNode;
  readonly panel: ReactNode;
  readonly tip: ReactNode;
  readonly problem?: string | null;
  readonly busy?: boolean;
  readonly canLock?: boolean;
  readonly onLock: () => void;
  readonly onUnlock: () => void;
  readonly onOpen: () => void;
  readonly onCancel: () => void;
}) {
  if (phase.at === "closed" || phase.at === "damaged") {
    return (
      <LockedBlock damaged={phase.at === "damaged"} onOpen={onOpen}>
        {panel === null ? undefined : (
          <>
            {panel}
            <button type="button" className="row-action quiet" onClick={onCancel}>Not now</button>
          </>
        )}
      </LockedBlock>
    );
  }
  if (phase.at === "reading") return <div className="lockable" aria-busy="true"><div className="lockable-main" /></div>;
  if (panel !== null) {
    return (
      <div className="lockable">
        <div className="lockable-panel">
          {panel}
          <button type="button" className="row-action quiet" onClick={onCancel}>Not now</button>
        </div>
      </div>
    );
  }
  const text = phase.text;
  return (
    <div className="lockable">
      <div className="lockable-main">{editor}</div>
      <div className="lockable-side">
        {phase.at === "open" ? (
          <>
            <span className="lock-mark" role="img" aria-label="Locked"><LockIcon /></span>
            <button type="button" className="row-action" disabled={busy} onClick={onUnlock}>Unlock for good</button>
          </>
        ) : (
          text !== null && text.trim() !== "" && (
            <button type="button" className="lock-btn" aria-label="Lock" disabled={busy || !canLock} onClick={onLock}><LockIcon /></button>
          )
        )}
        {phase.at === "plain" && tip}
      </div>
      {problem !== null && <span className="account-row-note lockable-panel" role="alert">{problem}</span>}
    </div>
  );
}

/**
 * What a save sends as "was", the way back for undo. A locked field that is open on screen shows
 * plain text, but what is stored is the envelope, so the envelope is the way back and plain text
 * never leaves the device.
 */
export function wasFor(openAndSealed: boolean, stored: string | null, shown: string | null): string | null {
  return openAndSealed ? stored : shown;
}

const sentence = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * Wraps an editor and gives it a lock. `value` is what is stored (plain text or one envelope) and
 * `save` sends what to store, with what was stored before it, which is the way back for undo: a
 * locked field is sealed on this device first, so only the envelope ever goes out. `children`
 * draws the editor on the text as it reads, and its saves come back through here.
 *
 * Lock with no key runs the key's setup first; with a key this device does not hold it asks for a
 * way in. Unlock for good asks one way in and then saves plain text.
 */
export function LockableText<K extends LockableKind>({ kind, id, field, value, save, children }: {
  readonly kind: K;
  readonly id: string;
  readonly field: LockableField<K>;
  readonly value: string | null;
  readonly save: (stored: string, was: string | null) => Promise<Outcome | boolean> | void;
  readonly children: (editor: { readonly value: string | null; readonly onSave: SaveText }) => ReactNode;
}) {
  const vault = useVault();
  const sealed = value !== null && isSealed(value);
  const [read, setRead] = useState<LockPhase>({ at: "reading" });
  const [panel, setPanel] = useState<LockPanel | null>(null);
  const [then, setThen] = useState<"lock" | "open" | null>(null);
  const [keys, setKeys] = useState<KeyState | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const latest = useRef(value);
  latest.current = value;

  const ways = useMemo(() => (vault.account === null ? null : keyWays(vault.account)), [vault.account]);
  const prf = useMemo(() => prfPossible(), []);

  // A locked field is read on this device whenever its stored text or the key's state changes.
  useEffect(() => {
    if (value === null || !isSealed(value)) return undefined;
    let current = true;
    void (async () => {
      const answer = await vault.openField(kind, id, field, value);
      if (!current) return;
      if (answer.status === "open") setRead({ at: "open", text: answer.text });
      else setRead({ at: answer.status === "locked" ? "closed" : "damaged" });
    })();
    return () => { current = false; };
  }, [vault, kind, id, field, value]);

  // Way-in panels need the key's rows.
  useEffect(() => {
    if (panel === null || panel === "setup") return undefined;
    let current = true;
    keysNow().then((rows) => { if (current) setKeys(rows); }, (error: unknown) => { if (current) setProblem(sentence(error)); });
    return () => { current = false; };
  }, [panel]);

  const phase: LockPhase = sealed ? read : { at: "plain", text: value };

  const close = (): void => { setPanel(null); setThen(null); setProblem(null); };

  const track = async (sent: Promise<Outcome | boolean> | void): Promise<Outcome | boolean> => {
    const result = (await sent) ?? true;
    if (result !== false) setSaved(true);
    return result;
  };

  /** Seals the plain text now in the field and saves the envelope. */
  const lockNow = async (): Promise<void> => {
    const text = latest.current;
    if (text === null || isSealed(text) || text.trim() === "") return;
    setBusy(true);
    setProblem(null);
    try {
      const envelope = await vault.sealField(kind, id, field, text);
      if (envelope === null) {
        setPanel(vault.state === "none" ? "setup" : "unlock");
        return;
      }
      markTipSeen("lock");
      setRead({ at: "open", text });
      const result = await save(envelope, text);
      if (result === false) setRead({ at: "plain", text });
      else close();
    } catch (error) {
      setProblem(sentence(error));
    } finally {
      setBusy(false);
    }
  };

  const onLock = (): void => {
    if (vault.state === "open") void lockNow();
    else if (vault.state === "none") { setThen("lock"); setPanel("setup"); }
    else if (vault.state === "closed") { setThen("lock"); setPanel("unlock"); }
  };

  const onKeyReady = (opened: Opened): void => {
    vault.opened(opened);
    const next = then;
    setPanel(null);
    setThen(null);
    // The vault holds the key from here, so the seal can follow at once.
    if (next === "lock") void lockNow();
  };

  const onSave: SaveText = (next, was) => {
    const openAndSealed = read.at === "open" && sealed;
    // Clearing a locked field saves the empty text plain, as nothing is left to hide; its way back is still the envelope.
    if (!openAndSealed || next.trim() === "") return track(save(next, wasFor(openAndSealed, latest.current, was)));
    return (async () => {
      const envelope = await vault.sealField(kind, id, field, next);
      if (envelope === null) return false;
      const before = read;
      setRead({ at: "open", text: next });
      const result = await track(save(envelope, latest.current));
      if (result === false) setRead(before);
      return result;
    })();
  };

  const unlockForGood = async (way: OpenWay): Promise<void> => {
    if (ways === null || read.at !== "open") return;
    setBusy(true);
    setProblem(null);
    try {
      await ways.prove(way);
      const result = await save(read.text, latest.current);
      if (result !== false) close();
      else setProblem("Couldn't unlock it. Try again.");
    } catch (error) {
      setProblem(sentence(error));
    } finally {
      setBusy(false);
    }
  };

  let panelNode: ReactNode = null;
  if (panel === "setup" && ways !== null) {
    panelNode = <KeySetup prepare={(way) => ways.prepareSetUp(way)} prf={prf} onSaved={onKeyReady} />;
  } else if (panel === "unlock" && ways !== null && keys !== null) {
    panelNode = (
      <KeyUnlock ways={ways} keys={keys} prf={prf} email={vault.account} origin={window.location.origin} onOpened={onKeyReady} />
    );
  } else if (panel === "prove" && keys !== null) {
    panelNode = <ProofForm ways={proofWays(keys, prf)} disabled={false} busy={busy} problem={problem} onProve={(way) => void unlockForGood(way)} />;
  }
  const editor = children({ value: phase.at === "plain" || phase.at === "open" ? phase.text : null, onSave });
  return (
    <LockableView phase={phase} editor={editor} panel={panelNode} busy={busy}
      canLock={vault.state === "open" || vault.state === "none" || vault.state === "closed"}
      tip={saved ? <Tip name="lock" /> : null} problem={panel === null ? problem : null}
      onLock={onLock} onUnlock={() => { setProblem(null); setPanel("prove"); }}
      onOpen={() => { setThen("open"); setPanel("unlock"); }} onCancel={close} />
  );
}
