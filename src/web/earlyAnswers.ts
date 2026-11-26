/**
 * The answers `public/early.js` asked for while the page's scripts were still downloading. Each
 * can be taken once, by the first read of that address, and only while it is fresh: a page that
 * has been open a while, or one that has been through a sign-in since, asks the Worker itself.
 * Without the script (the /try page, a test) nothing is held and every read goes to the Worker.
 */

interface Held {
  readonly at: number;
  readonly answer: Promise<Response>;
}

declare global {
  interface Window {
    vemiEarly?: Record<string, Held>;
    vemiStarted?: boolean;
  }
}

/** Tells `early.js`, should it run late, that the app asks for itself: it then holds nothing. */
export function appStarted(): void {
  if (typeof window !== "undefined") window.vemiStarted = true;
}

const FRESH_MS = 15_000;

/** The held answer for `path`, gone from the page once taken; null when there is none or it is old. */
export function takeEarly(path: string): Promise<Response> | null {
  const all = typeof window === "undefined" ? undefined : window.vemiEarly;
  const held = all?.[path];
  if (all === undefined || held === undefined) return null;
  delete all[path];
  return Date.now() - held.at <= FRESH_MS ? held.answer : null;
}

/** A fetch whose first try may be the held answer; a held answer that failed is asked for again. */
export async function fetchOrEarly(path: string, init: RequestInit = {}): Promise<Response> {
  const held = takeEarly(path);
  if (held === null) return fetch(path, init);
  return held.catch(() => fetch(path, init));
}
