/**
 * App lock: a per-device cover, never the server's. The setting and the last time the page was
 * seen are kept in this browser, keyed by account, so a reload or a cold open past the chosen
 * time still starts covered. The cover is not encryption; it keeps a glance out, and opening it
 * is checked by the vault's own ways in (`prove`). Pure but for the storage handed in.
 */

export type AppLockChoice = "off" | "1m" | "5m" | "1h";

export interface AppLockOption {
  readonly id: AppLockChoice;
  readonly label: string;
  /** Away this long and the cover comes back; null for off. */
  readonly ms: number | null;
}

export const APP_LOCK_OPTIONS: readonly AppLockOption[] = [
  { id: "off", label: "Off", ms: null },
  { id: "1m", label: "1 minute", ms: 60_000 },
  { id: "5m", label: "5 minutes", ms: 300_000 },
  { id: "1h", label: "1 hour", ms: 3_600_000 },
];

export interface LockStore {
  get(key: string): string | null;
  set(key: string, value: string): void;
}

/** This browser's storage; every call is safe where storage is blocked or missing. */
export function browserLockStore(): LockStore {
  return {
    get(key) {
      try {
        return globalThis.localStorage?.getItem(key) ?? null;
      } catch {
        return null;
      }
    },
    set(key, value) {
      try {
        globalThis.localStorage?.setItem(key, value);
      } catch {
        // Storage refused: the cover just does not remember.
      }
    },
  };
}

/** A store that lives in memory, for tests. */
export function memoryLockStore(): LockStore {
  const held = new Map<string, string>();
  return { get: (key) => held.get(key) ?? null, set: (key, value) => void held.set(key, value) };
}

const settingKey = (account: string): string => `vemi:appLock:v1:${account}`;
const seenKey = (account: string): string => `vemi:appLockSeen:v1:${account}`;

const isChoice = (value: unknown): value is AppLockChoice => APP_LOCK_OPTIONS.some((o) => o.id === value);

const listeners = new Set<() => void>();

/** Calls `fn` whenever a setting is written in this page. Returns the way to stop. */
export function onAppLockChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => void listeners.delete(fn);
}

/** The chosen time for `account` on this device. Off when nothing valid is kept. */
export function readAppLock(account: string, store: LockStore): AppLockChoice {
  const kept = store.get(settingKey(account));
  return isChoice(kept) ? kept : "off";
}

/** Keeps the choice. A choice other than off counts as seen now, so choosing it does not cover the page at once. */
export function writeAppLock(account: string, choice: AppLockChoice, now: number, store: LockStore): void {
  store.set(settingKey(account), choice);
  if (choice !== "off") store.set(seenKey(account), String(now));
  for (const fn of listeners) fn();
}

/** Notes that the page is open and uncovered at `now`. */
export function markSeen(account: string, now: number, store: LockStore): void {
  store.set(seenKey(account), String(now));
}

/** The last time the page was seen uncovered, or null. */
export function lastSeen(account: string, store: LockStore): number | null {
  const kept = Number(store.get(seenKey(account)));
  return Number.isFinite(kept) && kept > 0 ? kept : null;
}

/**
 * Whether the cover is due. A page never seen, or seen in the future by a clock set back, is
 * covered: the conservative reading.
 */
export function isLocked(choice: AppLockChoice, seen: number | null, now: number): boolean {
  const limit = APP_LOCK_OPTIONS.find((o) => o.id === choice)?.ms ?? null;
  if (limit === null) return false;
  if (seen === null || seen > now) return true;
  return now - seen >= limit;
}

/** `isLocked` from what this device keeps for `account`. */
export function lockedNow(account: string, now: number, store: LockStore): boolean {
  return isLocked(readAppLock(account, store), lastSeen(account, store), now);
}
