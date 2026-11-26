/**
 * Installing VEMI from inside it. Chrome and Edge hold back their own install offer and hand it
 * to the page as `beforeinstallprompt`; the address-bar icon is easy to miss, so the Account
 * panel and the phone's ⋯ menu offer it by name. Safari has no such event: on an iPhone the
 * offer is the two taps Safari itself needs.
 *
 * The event fires once, early, so `listenForInstall` runs before the app draws.
 */
import { useSyncExternalStore } from "react";

interface InstallEvent extends Event {
  prompt(): Promise<void>;
  readonly userChoice: Promise<{ readonly outcome: "accepted" | "dismissed" }>;
}

/** What the page can offer: a button that opens the browser's own install, the iPhone's steps, or nothing. */
export type InstallOffer = "button" | "ios" | null;

/** Pure, so every browser's case is tested without one. */
export function installOffer(state: { readonly promptReady: boolean; readonly standalone: boolean; readonly ios: boolean }): InstallOffer {
  if (state.standalone) return null;
  if (state.promptReady) return "button";
  return state.ios ? "ios" : null;
}

/** Pure. An iPhone, or an iPad, which says it is a Mac but has a touch screen. */
export function isIos(browser: { readonly userAgent: string; readonly maxTouchPoints?: number }): boolean {
  if (/iPhone|iPad|iPod/.test(browser.userAgent)) return true;
  return /Macintosh/.test(browser.userAgent) && (browser.maxTouchPoints ?? 0) > 1;
}

let held: InstallEvent | null = null;
let installed = false;
const listeners = new Set<() => void>();
const told = (): void => {
  for (const listener of listeners) listener();
};

export function listenForInstall(): void {
  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    held = event as InstallEvent;
    told();
  });
  window.addEventListener("appinstalled", () => {
    held = null;
    installed = true;
    told();
  });
}

/** True when this page runs as the installed app. */
export function isStandalone(): boolean {
  if (installed) return true;
  const iosStandalone = (navigator as { standalone?: boolean }).standalone === true;
  return iosStandalone || window.matchMedia("(display-mode: standalone)").matches;
}

function ios(): boolean {
  return isIos(navigator);
}

function current(): InstallOffer {
  return installOffer({ promptReady: held !== null, standalone: isStandalone(), ios: ios() });
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useInstallOffer(): InstallOffer {
  return useSyncExternalStore(subscribe, current, () => null);
}

/** Opens the browser's own install. The event can be used once, so it is let go either way. */
export async function install(): Promise<void> {
  const event = held;
  if (event === null) return;
  held = null;
  told();
  await event.prompt();
  await event.userChoice;
}

/** The two taps Safari needs, said where the button would be. */
export const IOS_STEPS = "In Safari, tap Share, then Add to Home Screen.";
