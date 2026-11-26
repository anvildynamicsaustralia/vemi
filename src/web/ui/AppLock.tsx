import { type ReactNode, useCallback, useEffect, useState, useSyncExternalStore } from "react";
import type { KeyState } from "../api.js";
import {
  APP_LOCK_OPTIONS, type AppLockChoice, type LockStore, browserLockStore, lockedNow, markSeen,
  onAppLockChange, readAppLock, writeAppLock,
} from "../appLock.js";
import type { OpenWay, Opened, PendingKey, SetUpWay } from "../keyWays.js";
import { Chip } from "./Chip.js";
import { KeySetup } from "./KeySetup.js";
import { ProofForm, proofWays } from "./KeyPair.js";
import { StatusWord } from "./Group.js";
import "./appLock.css";

const sentence = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** How often a page that is open and uncovered notes the time, so a closed tab still has a recent one. */
const SEEN_EVERY_MS = 15_000;

/**
 * The blurred cover, pure. Asks Face ID or a fingerprint, or the vault password; the recovery key
 * only where nothing else can open this device, so the cover is never a dead end.
 */
export function LockCover({ keys, prf, busy, problem, onProve, onTryAgain }: {
  /** Null until the Worker has answered. */
  readonly keys: KeyState | null;
  readonly prf: boolean;
  readonly busy: boolean;
  readonly problem: string | null;
  readonly onProve: (way: OpenWay) => void;
  readonly onTryAgain: () => void;
}) {
  const all = keys === null ? null : proofWays(keys, prf);
  const ways = all === null ? null : { ...all, recovery: all.recovery && !all.passkey && !all.password };
  return (
    <div className="app-lock-cover" role="dialog" aria-modal="true" aria-label="VEMI is locked">
      <div className="app-lock-panel">
        <span className="app-lock-title">Locked</span>
        {ways === null ? (
          problem === null ? (
            <span className="account-row-note">Getting ready</span>
          ) : (
            <>
              <span className="account-row-note" role="alert">{problem}</span>
              <button type="button" className="primary-button" onClick={onTryAgain}>Try again</button>
            </>
          )
        ) : (
          <ProofForm ways={ways} disabled={false} busy={busy} problem={problem} onProve={onProve} />
        )}
      </div>
    </div>
  );
}

/**
 * Covers the page after the chosen time away, and on a cold open past it, for `account` on this
 * device. Opening the cover is `prove`, which checks one way in and adds no device row. The page
 * behind stays in the tree but inert, so nothing under the cover can be reached.
 */
export function AppLock({ account, prf, now = Date.now, store, loadKeys, prove, children }: {
  readonly account: string | null;
  readonly prf: boolean;
  readonly now?: () => number;
  readonly store?: LockStore;
  readonly loadKeys: () => Promise<KeyState>;
  readonly prove: (way: OpenWay) => Promise<void>;
  readonly children: ReactNode;
}) {
  const [kept] = useState<LockStore>(() => store ?? browserLockStore());
  const [locked, setLocked] = useState(() => account !== null && lockedNow(account, now(), kept));
  const [keys, setKeys] = useState<KeyState | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  // The time chosen, or the cover coming off, in this page.
  useEffect(() => {
    if (account === null) return;
    return onAppLockChange(() => {
      if (readAppLock(account, kept) === "off") setLocked(false);
    });
  }, [account, kept]);

  // While uncovered the page notes the time; on leaving and on return the cover is decided.
  useEffect(() => {
    if (account === null || locked) return;
    const note = (): void => {
      if (readAppLock(account, kept) !== "off") markSeen(account, now(), kept);
    };
    const onVisibility = (): void => {
      if (document.visibilityState === "hidden") {
        note();
      } else if (lockedNow(account, now(), kept)) {
        setLocked(true);
      } else {
        note();
      }
    };
    note();
    const timer = setInterval(() => { if (document.visibilityState === "visible") note(); }, SEEN_EVERY_MS);
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pagehide", note);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", note);
    };
  }, [account, locked, kept, now]);

  const look = useCallback(async (): Promise<void> => {
    setProblem(null);
    try {
      const next = await loadKeys();
      // With no key there is nothing to prove against, so the cover cannot hold.
      if (next.keyRef === null) setLocked(false);
      else setKeys(next);
    } catch (error) {
      setProblem(sentence(error));
    }
  }, [loadKeys]);
  useEffect(() => { if (locked) void look(); }, [locked, look]);

  const open = async (way: OpenWay): Promise<void> => {
    if (account === null) return;
    setBusy(true);
    setProblem(null);
    try {
      await prove(way);
      markSeen(account, now(), kept);
      setKeys(null);
      setLocked(false);
    } catch (error) {
      setProblem(sentence(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="app-lock-scope" inert={locked}>{children}</div>
      {locked && <LockCover keys={keys} prf={prf} busy={busy} problem={problem} onProve={(way) => void open(way)} onTryAgain={() => void look()} />}
    </>
  );
}

type RowStage = { readonly at: "rows" } | { readonly at: "setup"; readonly then: AppLockChoice };

/**
 * Account > Privacy and security: the App lock row. Four choices; picking one before there is a
 * key runs `KeySetup` first and keeps the choice only once the key is saved.
 */
export function AppLockRow({ account, hasKey, prf, prepare, onKeySaved, now = Date.now, store }: {
  readonly account: string;
  /** Whether this account has a key. */
  readonly hasKey: boolean;
  readonly prf: boolean;
  readonly prepare: (way: SetUpWay) => Promise<PendingKey>;
  readonly onKeySaved: (opened: Opened) => void;
  readonly now?: () => number;
  readonly store?: LockStore;
}) {
  const [kept] = useState<LockStore>(() => store ?? browserLockStore());
  const choice = useSyncExternalStore(
    onAppLockChange,
    () => readAppLock(account, kept),
    () => readAppLock(account, kept),
  );
  const [stage, setStage] = useState<RowStage>({ at: "rows" });

  if (stage.at === "setup") {
    const then = stage.then;
    return (
      <KeySetup prepare={prepare} prf={prf}
        onSaved={(opened) => {
          onKeySaved(opened);
          writeAppLock(account, then, now(), kept);
          setStage({ at: "rows" });
        }} />
    );
  }

  const pick = (next: AppLockChoice): void => {
    if (next === choice) return;
    if (next !== "off" && !hasKey) setStage({ at: "setup", then: next });
    else writeAppLock(account, next, now(), kept);
  };

  return (
    <div className="account-row app-lock-row">
      <span className="account-row-title">
        App lock
        <span className="account-row-note"><StatusWord on={choice !== "off"}>{choice === "off" ? "Off" : `Locks after ${APP_LOCK_OPTIONS.find((o) => o.id === choice)?.label ?? ""}`}</StatusWord></span>
      </span>
      <span className="app-lock-choices seg" role="group" aria-label="App lock">
        {APP_LOCK_OPTIONS.map((o) => (
          <Chip key={o.id} on={choice === o.id} className="app-lock-choice" aria-pressed={choice === o.id} onClick={() => pick(o.id)}>
            {o.label}
          </Chip>
        ))}
      </span>
    </div>
  );
}
