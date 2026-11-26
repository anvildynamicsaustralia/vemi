/**
 * What the page at `/try` hands the app that the app cannot import itself. The signed-in
 * app's entry bundle must not name the local database or its channel, so `start.ts`, which only
 * `/try` loads, puts the channel here before the app runs, and the app asks for it only where
 * `isLocal()` is true.
 */
import type { LocalChannel } from "../../local/channel.js";
import type { WipeResult } from "./wipe.js";

let opener: (() => LocalChannel) | null = null;

/** Called once, by `start.ts`. */
export function provideChannel(open: () => LocalChannel): void {
  opener = open;
}

/** A channel to the other tabs of this copy. Throws when asked outside `/try`. */
export function openChannel(): LocalChannel {
  if (opener === null) throw new Error("This page keeps no data in the browser.");
  return opener();
}

/** What the page asks of the database's owner: whether what it keeps lasts only until the page closes. */
export interface VolatileSource {
  now(): boolean | null;
  onChange(listener: () => void): () => void;
}

let volatileSource: VolatileSource | null = null;

/** Called once, by `start.ts`. */
export function provideVolatile(source: VolatileSource): void {
  volatileSource = source;
}

/** True when the database is only in memory, false when it is kept, null when no tab has said or outside `/try`. */
export function volatileNow(): boolean | null {
  return volatileSource?.now() ?? null;
}

/** Calls back when `volatileNow` may have changed. */
export function onVolatile(listener: () => void): () => void {
  return volatileSource?.onChange(listener) ?? (() => {});
}

let wiper: (() => Promise<WipeResult>) | null = null;

/** Called once, by `start.ts`: how to empty this device. */
export function provideWipe(wipe: () => Promise<WipeResult>): void {
  wiper = wipe;
}

/** Empties this device. Fails with a sentence outside `/try`, where nothing is kept. */
export function wipeNow(): Promise<WipeResult> {
  return wiper === null ? Promise.resolve({ ok: false, reason: "This page keeps no data in the browser." }) : wiper();
}
