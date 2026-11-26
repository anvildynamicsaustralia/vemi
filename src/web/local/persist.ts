/**
 * Keeping the data, in the page at `/try`. Some browsers clear a site's data after a while of
 * not using it; `navigator.storage.persist()` asks them not to, and the answer is kept. From that
 * answer, the browser and whether the database is only in memory, one pure rule says what Your
 * data tells the person: nothing extra, that the browser may clear the data, or that nothing
 * is being kept. The first is silent, the second shows once, the third on every open.
 */
import { isIos } from "../installPrompt.js";
import type { StorageLike } from "./storage.js";

export const KEEPING_MAY_CLEAR = "This browser may clear VEMI's data if you do not use it for a while. Export now and then.";
export const KEEPING_NOTHING = "Nothing is being kept in this browser right now. What you add goes when this page closes.";

/** Safari on an iPhone or iPad, Safari on a Mac, or any other browser. */
export type Platform = "ios-safari" | "safari" | "other";
export type Keeping = "none" | "may-clear" | "nothing-kept";

/** Pure: which browser this is, as far as keeping data cares. */
export function platformOf(browser: { readonly userAgent: string; readonly maxTouchPoints?: number }): Platform {
  if (isIos(browser)) return "ios-safari";
  const { userAgent } = browser;
  return /Version\/[\d.]+.*Safari\//.test(userAgent) && !/Chrome|Chromium|CriOS|FxiOS|Edg|OPR/.test(userAgent) ? "safari" : "other";
}

/**
 * Pure. `persisted` is the browser's answer to persist() (null when it could not be asked),
 * `volatile` is whether the database fell back to memory (null until a tab has said).
 */
export function keepingRule(state: {
  readonly persisted: boolean | null;
  readonly volatile: boolean | null;
  readonly standalone: boolean;
  readonly platform: Platform;
}): Keeping {
  if (state.volatile === true) return "nothing-kept";
  if (state.persisted === false) return "may-clear";
  if (state.platform !== "other" && !state.standalone) return "may-clear";
  if (state.persisted === null && !state.standalone) return "may-clear";
  return "none";
}

const ANSWER = "vemi:keeping:persisted:v1";
const SEEN = "vemi:keeping:seen:v1";

/** The part of `navigator` that is asked. */
export interface StorageAsker {
  readonly storage?: { readonly persist?: () => Promise<boolean> };
}

/** Asks the browser to keep the data, and keeps what it said. Null when it cannot be asked. */
export async function askToKeep(nav: StorageAsker, store: StorageLike): Promise<boolean | null> {
  let answer: boolean | null = null;
  try {
    const persist = nav.storage?.persist;
    if (typeof persist === "function") answer = (await persist.call(nav.storage)) === true;
  } catch {
    answer = null;
  }
  try {
    if (answer === null) store.removeItem(ANSWER);
    else store.setItem(ANSWER, answer ? "yes" : "no");
  } catch {
    // Without storage the answer is still given this once.
  }
  return answer;
}

/** The answer kept by the last open, or null. */
export function rememberedAnswer(store: StorageLike): boolean | null {
  try {
    const kept = store.getItem(ANSWER);
    return kept === "yes" ? true : kept === "no" ? false : null;
  } catch {
    return null;
  }
}

export function keepingSeen(store: StorageLike): boolean {
  try {
    return store.getItem(SEEN) === "yes";
  } catch {
    return false;
  }
}

export function markKeepingSeen(store: StorageLike): void {
  try {
    store.setItem(SEEN, "yes");
  } catch {
    // Without storage the line shows again; that is the safe way to fail.
  }
}

let asked: Promise<boolean | null> | null = null;

/** Called once at the start of the page: asks the browser, and holds the pending answer. */
export function startKeeping(nav: StorageAsker, store: StorageLike): void {
  asked = askToKeep(nav, store);
}

/** The answer of this open, once the browser has given it; the kept one if the page never asked. */
export function keepingAnswer(store: StorageLike): Promise<boolean | null> {
  return asked ?? Promise.resolve(rememberedAnswer(store));
}

/** The page's own storage, looked up at each use, so a browser that refuses it fails inside the callers' guards. */
export function pageStore(): StorageLike {
  const store = (): StorageLike => window.localStorage;
  return {
    get length() { return store().length; },
    key: (index) => store().key(index),
    getItem: (key) => store().getItem(key),
    setItem: (key, value) => store().setItem(key, value),
    removeItem: (key) => store().removeItem(key),
    clear: () => store().clear(),
  };
}
