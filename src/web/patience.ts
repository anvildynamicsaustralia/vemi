/**
 * How long a start waits on the network before it shows what this device kept. On a weak
 * signal a request can hang for minutes, and a blank boot screen is worse than a map that
 * is a little old.
 *
 * `sw.js` keeps its own copy of this, because a service worker cannot import from `src`.
 * It is the twin: change the two together.
 */
export const PATIENCE_MS = 4000;

/** The promise's own answer, or a rejection once `ms` have passed. The timer never outlives it. */
export function withPatience<T>(promise: Promise<T>, ms: number = PATIENCE_MS): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("slow")), ms);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (err: unknown) => { clearTimeout(timer); reject(err); },
    );
  });
}
