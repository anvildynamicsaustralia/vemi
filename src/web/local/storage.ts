/**
 * Every `localStorage` key the app writes, kept under one prefix in local mode.
 *
 * `/try` is served from the same origin as the copy that serves it, so without this a
 * person's local tasks and their signed-in app would share keys (the outbox, the app lock,
 * the first-run state). `installLocalStorage` replaces the page's `localStorage` once, at
 * start, with a view of it whose keys all begin `vemi:local:`. The seventeen files that touch
 * storage are not edited: they ask for `vemi:outbox:v1` and the backing store holds
 * `vemi:local:vemi:outbox:v1`. Only keys under the prefix are ever seen, counted or cleared.
 */

/** The part of `Storage` the app uses. */
export interface StorageLike {
  readonly length: number;
  key(index: number): string | null;
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  clear(): void;
}

export const LOCAL_PREFIX = "vemi:local:";

/** A view of `backing` in which every key lives under `prefix`. */
export function namespaced(backing: StorageLike, prefix: string = LOCAL_PREFIX): StorageLike {
  const mine = (): string[] => {
    const keys: string[] = [];
    for (let i = 0; i < backing.length; i++) {
      const key = backing.key(i);
      if (key !== null && key.startsWith(prefix)) keys.push(key);
    }
    return keys;
  };
  return {
    get length() {
      return mine().length;
    },
    key: (index) => mine()[index]?.slice(prefix.length) ?? null,
    getItem: (key) => backing.getItem(prefix + key),
    setItem: (key, value) => backing.setItem(prefix + key, value),
    removeItem: (key) => backing.removeItem(prefix + key),
    clear: () => {
      for (const key of mine()) backing.removeItem(key);
    },
  };
}

/**
 * Wraps `target.localStorage` once. Where the browser refuses the storage at all (the
 * property throws), nothing is replaced: the app already runs without storage.
 */
export function installLocalStorage(target: { localStorage: StorageLike }): void {
  let backing: StorageLike;
  try {
    backing = target.localStorage;
  } catch {
    return;
  }
  Object.defineProperty(target, "localStorage", { configurable: true, enumerable: true, value: namespaced(backing) });
}
