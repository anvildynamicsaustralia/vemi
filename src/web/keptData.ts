/**
 * The service worker's copy of the last answer to each read, forgotten from the page.
 *
 * Signing out and a change of account both rest on this: the copy is one person's plans, and
 * the next person on this device is handed it whenever a read is slow or there is no signal.
 * Telling the controlling worker is not enough, because a hard reload, or a first load before
 * the worker claims the page, has no controller and the message went nowhere. The window's
 * own Cache API reaches the same caches, so the page deletes the copy itself, and tells the
 * active worker as well, so a read it has in flight is not kept after.
 */

/** The cache the worker keeps answers in. `sw.js` names it `DATA`, and cannot import this: change both. */
export const DATA_CACHE = "vemi-data-v1";

interface Worker {
  postMessage(message: unknown): void;
}

export interface KeptPlaces {
  readonly caches: Pick<CacheStorage, "delete"> | undefined;
  readonly serviceWorker: { readonly ready: Promise<{ readonly active: Worker | null }> } | undefined;
}

/** Where they are in a browser. Either is missing outside a secure context. */
function browser(): KeptPlaces {
  return {
    caches: typeof caches === "undefined" ? undefined : caches,
    serviceWorker: typeof navigator === "undefined" ? undefined : navigator.serviceWorker,
  };
}

/** Settles once the copy is gone. Never rejects: a cache that cannot be reached kept nothing. */
export async function forgetKeptData(places: KeptPlaces = browser()): Promise<void> {
  // Not waited on: `ready` never settles where no worker was registered.
  void places.serviceWorker?.ready.then((r) => r.active?.postMessage("forget-data"), () => undefined);
  await places.caches?.delete(DATA_CACHE).catch(() => false);
}
