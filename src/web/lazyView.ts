import { lazy, type ComponentType, type LazyExoticComponent } from "react";

type PropsOf<C> = C extends ComponentType<infer P> ? P : never;

const RELOADED = "vemi:view-reloaded:v1";

/** Marks that this tab has reloaded for a failed view; returns false when it already had. */
export function reloadOnce(store: Pick<Storage, "getItem" | "setItem">, reload: () => void): boolean {
  try {
    if (store.getItem(RELOADED) !== null) return false;
    store.setItem(RELOADED, "1");
  } catch {
    // Without storage a reload cannot be told from a loop, so none is made.
    return false;
  }
  reload();
  return true;
}

/** A view loaded fine, so the next failure may reload once more. */
export function loadedFine(store: Pick<Storage, "removeItem">): void {
  try {
    store.removeItem(RELOADED);
  } catch {
    // Nothing to forget.
  }
}

/** What a view whose import failed twice throws, so the boundary reloads for it and for no other error. */
export class ViewLoadError extends Error {}

/** Loads the view; a failed import (a tab left open across a deploy, a flaky network) is tried once more. */
export async function loadWithRetry<M>(load: () => Promise<M>): Promise<M> {
  try {
    return await load();
  } catch {
    return load();
  }
}

/** Loads a view once, and twice if the first try failed; a second failure is a `ViewLoadError`. */
export async function loadView<M>(load: () => Promise<M>): Promise<M> {
  let loaded: M;
  try {
    loaded = await loadWithRetry(load);
  } catch {
    throw new ViewLoadError("A screen did not load.");
  }
  if (typeof sessionStorage !== "undefined") loadedFine(sessionStorage);
  return loaded;
}

/**
 * A screen or sheet fetched when first needed, so the first screen's download carries only what
 * the first screen uses. Draw it inside a `ViewBoundary`, which waits quietly and, should the
 * import fail twice, reloads the page once.
 */
export function lazyNamed<M, K extends keyof M>(
  load: () => Promise<M>,
  name: K,
): LazyExoticComponent<ComponentType<PropsOf<M[K]>>> {
  return lazy(async () => {
    const loaded = await loadView(load);
    return { default: loaded[name] as unknown as ComponentType<PropsOf<M[K]>> };
  });
}
