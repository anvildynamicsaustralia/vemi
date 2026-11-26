/**
 * Back closes a sheet. On a phone, and most of all in the installed app, the hardware Back or
 * the edge swipe is the way out of anything, and it went past the sheet: it changed the page
 * underneath, or left the app, with the sheet still drawn.
 *
 * So a sheet that opens pushes a history entry at the address already shown, naming itself in
 * the entry's state. Back steps off it, which closes that sheet and nothing else. A sheet
 * closed any other way spends its own entry, so the next Back does not land on a step that
 * does nothing. And a page opened from inside a sheet takes the sheet's entry rather than
 * stacking on it (`router.ts`), so its Back goes to where the sheet was opened.
 *
 * Reads `window.history` and `window.location` only, like the router.
 */
import { isLocal } from "./local/mode.js";

const KEY = "vemiSheets";

/** The sheets on screen that hold an entry. One may close and another open in one render. */
const open = new Set<string>();

function here(): string {
  // In local mode the route is the hash, and an entry without it would drop the page.
  return `${window.location.pathname}${window.location.search}${isLocal() ? window.location.hash : ""}`;
}

/** The sheets an entry's state names, oldest first. */
export function sheetsOn(state: unknown): readonly string[] {
  if (typeof state !== "object" || state === null) return [];
  const named: unknown = (state as Record<string, unknown>)[KEY];
  return Array.isArray(named) ? named.filter((s): s is string => typeof s === "string") : [];
}

/**
 * Whether the entry Back is on is a sheet's. A page opened from it takes its place. One that
 * names a sheet no longer open counts too: it sits at the address beneath it, so a page
 * pushed on it would leave that duplicate for Back to land on.
 */
export function onSheetEntry(): boolean {
  return sheetsOn(window.history.state).length > 0;
}

/** Whether Back has stepped off this sheet's entry, so the sheet should close. */
export function steppedOff(id: string): boolean {
  return !sheetsOn(window.history.state).includes(id);
}

/** A sheet opened: an entry for Back to spend on it. */
export function holdEntry(id: string): void {
  open.add(id);
  const state: unknown = window.history.state;
  const on = sheetsOn(state);
  // Opened again in the same entry: React mounts twice in development.
  if (on.includes(id)) return;
  const still = on.filter((s) => open.has(s));
  const next = { ...(typeof state === "object" && state !== null ? state : {}), [KEY]: [...still, id] };
  // The entry on top is a sheet's that has just closed, and this one opened in its place —
  // a menu item that opens a picker. It takes that entry rather than stacking on it.
  if (still.length < on.length) window.history.replaceState(next, "", here());
  else window.history.pushState(next, "", here());
}

/**
 * Steps off an entry that names a sheet not on screen. A reload or a restored app with a sheet
 * open, Forward onto a sheet that has closed, or Back onto a sheet that closed under another:
 * each lands on an entry at the address beneath it with no sheet to close, so the next Back
 * would do nothing anyone could see. Stepping off it now spends that dead step.
 */
export function leaveDeadEntry(): void {
  if (sheetsOn(window.history.state).some((s) => !open.has(s))) window.history.back();
}

let started = false;

/**
 * Leaves a dead entry once at start, and again on every step through history. Called once
 * the first draw's sheets are up: a sheet opened from the address takes a dead entry over
 * (`holdEntry`), and only an entry nothing took is stepped off. Returns the unwatch.
 */
export function watchSheetEntries(): () => void {
  if (!started) {
    // Once: in development React runs this twice, and Back has not landed by the second.
    started = true;
    leaveDeadEntry();
  }
  window.addEventListener("popstate", leaveDeadEntry);
  return () => window.removeEventListener("popstate", leaveDeadEntry);
}

/**
 * A sheet closed. If it closed by any way but Back, its entry is still on top: step back off
 * it. Checked a moment later, so a sheet mounted again at once (development) keeps its entry,
 * and one that another sheet replaced leaves that sheet's alone.
 */
export function releaseEntry(id: string): void {
  open.delete(id);
  queueMicrotask(() => {
    if (open.has(id)) return;
    if (sheetsOn(window.history.state).at(-1) === id) window.history.back();
  });
}
