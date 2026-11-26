import { useMemo, useState, useSyncExternalStore } from "react";
import {
  type AppLockChoice, type LockStore, browserLockStore, onAppLockChange, readAppLock, writeAppLock,
} from "../appLock.js";
import { type FirstRun, markTipSeen, tipDue, useFirstRun } from "../firstRunState.js";
import { type Opened, type PendingKey, type SetUpWay, keyWays } from "../keyWays.js";
import { prfPossible } from "../passkeyPrf.js";
import type { VaultState } from "../vault.js";
import { KeySetup } from "./KeySetup.js";
import { useVault } from "./vaultContext.js";
import "./firstRun.css";

/** The seen name that keeps the offer from coming back. */
export const APP_LOCK_OFFER_NAME = "applock";

/** What Lock sets App lock to. */
const OFFER_CHOICE: AppLockChoice = "5m";

/**
 * Whether the one-time card is due. Only once first run has ended (no numbered step), where Face
 * ID or a fingerprint is possible, the account has no key and App lock is off, and it has not
 * been answered before.
 */
export function appLockOfferDue(facts: {
  readonly firstRun: FirstRun;
  readonly state: VaultState;
  readonly prf: boolean;
  readonly choice: AppLockChoice;
}): boolean {
  return facts.firstRun.step === null
    && tipDue(facts.firstRun, APP_LOCK_OFFER_NAME)
    && facts.prf
    && facts.state === "none"
    && facts.choice === "off";
}

/**
 * The card, drawn from what it is given. Lock runs `KeySetup`, then sets App lock to 5 minutes;
 * either button marks the offer seen, so it never returns.
 */
export function AppLockOffer({ account, firstRun, state, prf, prepare, onKeySaved, onSeen, now = Date.now, store }: {
  readonly account: string;
  readonly firstRun: FirstRun;
  readonly state: VaultState;
  readonly prf: boolean;
  readonly prepare: (way: SetUpWay) => Promise<PendingKey>;
  readonly onKeySaved: (opened: Opened) => void;
  /** Called when either button is pressed. */
  readonly onSeen: () => void;
  readonly now?: () => number;
  readonly store?: LockStore;
}) {
  const [kept] = useState<LockStore>(() => store ?? browserLockStore());
  const choice = useSyncExternalStore(
    onAppLockChange,
    () => readAppLock(account, kept),
    () => readAppLock(account, kept),
  );
  const [settingUp, setSettingUp] = useState(false);

  // Once Lock is pressed the card is already marked seen; the key setup stays until it is done.
  if (settingUp) {
    return (
      <KeySetup prepare={prepare} prf={prf}
        onSaved={(opened) => {
          onKeySaved(opened);
          writeAppLock(account, OFFER_CHOICE, now(), kept);
          setSettingUp(false);
        }} />
    );
  }

  if (!appLockOfferDue({ firstRun, state, prf, choice })) return null;

  return (
    <section className="first-run-card" aria-label="App lock">
      <h4>Lock VEMI with Face ID?</h4>
      <div className="first-run-buttons">
        <button type="button" className="first-run-action"
          onClick={() => { onSeen(); setSettingUp(true); }}>Lock</button>
        <button type="button" className="first-run-skip-now" onClick={onSeen}>Not now</button>
      </div>
    </section>
  );
}

/** The card as Today mounts it: the account, the vault and first run read from where they live. */
export function AppLockOfferHere() {
  const vault = useVault();
  const firstRun = useFirstRun();
  const account = vault.account;
  const ways = useMemo(() => (account === null ? null : keyWays(account)), [account]);
  const prf = useMemo(() => prfPossible(), []);
  if (account === null || ways === null) return null;
  return (
    <AppLockOffer account={account} firstRun={firstRun} state={vault.state} prf={prf}
      prepare={(way) => ways.prepareSetUp(way)} onKeySaved={(opened) => vault.opened(opened)}
      onSeen={() => markTipSeen(APP_LOCK_OFFER_NAME)} />
  );
}
