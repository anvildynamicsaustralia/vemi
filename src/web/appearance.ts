/**
 * The account's look, from storage to the page: accent, spacing and theme.
 *
 * VEMI-013 (design). The Worker keeps the three settings on the account (`/api/appearance`);
 * this module is the one place the web app reads them. `useAppearance` is the one hook, and
 * `startAppearance` is the one call at load. A change applies at once and is saved behind it,
 * so nothing waits on the network and nothing reloads.
 *
 * First paint cannot wait for the account, so the last answer is kept on this device under a
 * versioned key and applied before the app draws; the Worker's answer then replaces it. The
 * stored copy never throws and never answers with a value this build does not have.
 *
 * The root carries two attributes the stylesheet reads: `data-theme` (the table, resolved to
 * light or dark) and `data-spacing`. The accent is not an attribute: it is laid over both
 * tables by `applyTheme`, so every `var(--vemi-live)` follows it. "Match device" follows
 * `prefers-color-scheme` live, which is why this file, with `theme.ts`, may name it.
 */
import { useSyncExternalStore } from "react";
import {
  DEFAULT_APPEARANCE, START_SCREENS, isAccent, isMapStyle, isSpacing, isThemeMode,
  type Appearance, type StartScreen, type ThemeMode, type ThemeName,
} from "@vemi/shared";
import { paths, read, saveAppearance, saveStartOn, setAccountZone } from "./api.js";
import { readExtras, setExtras } from "./extras.js";
import { applyTheme } from "./theme.js";

const KEY = "vemi:appearance:v1";

/** What an unknown input says, setting by setting, with the default for each it cannot use. */
export function readAppearance(input: unknown): Appearance {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return DEFAULT_APPEARANCE;
  const src = input as Record<string, unknown>;
  return {
    accent: isAccent(src["accent"]) ? src["accent"] : DEFAULT_APPEARANCE.accent,
    spacing: isSpacing(src["spacing"]) ? src["spacing"] : DEFAULT_APPEARANCE.spacing,
    theme: isThemeMode(src["theme"]) ? src["theme"] : DEFAULT_APPEARANCE.theme,
    mapStyle: isMapStyle(src["mapStyle"]) ? src["mapStyle"] : DEFAULT_APPEARANCE.mapStyle,
  };
}

/** The table a mode means right now. Only "match device" asks the device. */
export function resolveTheme(mode: ThemeMode, deviceIsDark: boolean): ThemeName {
  if (mode === "system") return deviceIsDark ? "dark" : "light";
  return mode;
}

export const toStored = (a: Appearance): string => JSON.stringify(a);

/** The copy kept on this device, out of a stored string, whatever it turns out to be. */
export function storedAppearance(raw: string | null): Appearance {
  if (raw === null) return DEFAULT_APPEARANCE;
  try {
    return readAppearance(JSON.parse(raw));
  } catch {
    return DEFAULT_APPEARANCE;
  }
}

/**
 * What a page starts with before the account has answered: the copy kept on this device, or,
 * when nothing was ever kept (a signed-out visitor), the defaults with the light table rather
 * than the device's choice. A stored choice, dark or "match device", is still followed.
 */
export function startingAppearance(raw: string | null): Appearance {
  return raw === null ? { ...DEFAULT_APPEARANCE, theme: "light" } : storedAppearance(raw);
}

export const merged =(a: Appearance, change: Partial<Appearance>): Appearance => ({ ...a, ...change });

const DARK_QUERY = "(prefers-color-scheme: dark)";

function deviceIsDark(): boolean {
  try {
    return window.matchMedia(DARK_QUERY).matches;
  } catch {
    return false;
  }
}

/** Puts the settings on the page: the two tables with the accent, then the two attributes. */
function show(a: Appearance, root: HTMLElement = document.documentElement): void {
  applyTheme(root, resolveTheme(a.theme, deviceIsDark()), a.accent);
  root.setAttribute("data-spacing", a.spacing);
}

let current: Appearance = DEFAULT_APPEARANCE;
const listeners = new Set<() => void>();

function set(next: Appearance): void {
  current = next;
  try {
    localStorage.setItem(KEY, toStored(next));
  } catch {
    // Storage refused: the page still shows it, and the account still has it.
  }
  show(next);
  for (const listener of listeners) listener();
}

const START_KEY = "vemi:startOn:v1";

/** Which screen opens first, out of an unknown answer: the map unless it says today. */
export function readStartOn(input: unknown): StartScreen {
  const v = typeof input === "object" && input !== null ? (input as Record<string, unknown>)["startOn"] : undefined;
  return START_SCREENS.find((s) => s === v) ?? "map";
}

/** The copy kept on this device, out of a stored string, whatever it turns out to be. */
export const storedStartOn = (raw: string | null): StartScreen => START_SCREENS.find((s) => s === raw) ?? "map";

function keptStartOn(): StartScreen {
  try {
    return storedStartOn(localStorage.getItem(START_KEY));
  } catch {
    return "map";
  }
}

let startOn: StartScreen = keptStartOn();
const startListeners = new Set<() => void>();

function setStartOn(next: StartScreen): void {
  if (next === startOn) return;
  startOn = next;
  try {
    localStorage.setItem(START_KEY, next);
  } catch {
    // Storage refused: the account still has it.
  }
  for (const listener of startListeners) listener();
}

/** Which screen opens first, now. */
export const startOnNow = (): StartScreen => startOn;

/**
 * Where the bare address `/` opens, or null when it should be left alone: Today only when the
 * account says so, and only for `/` with nothing asked of it. The map keeps its own path
 * (`/map`), so choosing the map from inside the app never lands on Today.
 */
export function openOnPlace(pathname: string, search: string, on: StartScreen): "today" | null {
  return on === "today" && pathname === "/" && search === "" ? "today" : null;
}

/** Applies Open on now and saves it behind. */
export function changeStartOn(next: StartScreen): void {
  setStartOn(next);
  void saveStartOn(next).catch(() => undefined);
}

/** The one way a component reads Open on, and changes it. */
export function useStartOn(): { readonly startOn: StartScreen; readonly change: (s: StartScreen) => void } {
  const now = useSyncExternalStore(
    (listener) => { startListeners.add(listener); return () => { startListeners.delete(listener); }; },
    () => startOn,
    () => "map" as StartScreen,
  );
  return { startOn: now, change: changeStartOn };
}

/** The zone name in an answer, or null when the account never chose one. */
export function readZone(input: unknown): string | null {
  const v = typeof input === "object" && input !== null ? (input as Record<string, unknown>)["timeZone"] : undefined;
  return typeof v === "string" && v !== "" ? v : null;
}

/** What else the account's answer holds besides the look: Open on, the Extras and the zone. */
export function acceptAccount(answer: unknown): void {
  setStartOn(readStartOn(answer));
  const extras = typeof answer === "object" && answer !== null ? (answer as Record<string, unknown>)["extras"] : undefined;
  if (extras !== undefined) setExtras(readExtras(extras));
  setAccountZone(readZone(answer));
}

/** True from a start with no kept copy until the account answers: the page was drawn light, unasked. */
let drewLightUnasked = false;

/** The Worker's answer, if it will give one. A signed-out page or no connection keeps what it has. */
export async function refreshAppearance(): Promise<void> {
  try {
    const answer = await read<unknown>(paths.appearance);
    const next = readAppearance(answer.data);
    acceptAccount(answer.data);
    // A device with nothing kept drew light for the pages before sign-in; the account's answer
    // is drawn now even when it equals the default, so "match device" takes over from there.
    if (drewLightUnasked || toStored(next) !== toStored(current)) set(next);
    drewLightUnasked = false;
  } catch {
    // Not signed in yet, or unreachable: the copy on this device stands.
  }
}

/** Once, before the app draws: the kept copy, then follow the device. The account is asked once someone is signed in (`refreshAppearance`). */
export function startAppearance(): void {
  let kept: string | null = null;
  try {
    kept = localStorage.getItem(KEY);
  } catch {
    kept = null;
  }
  current = storedAppearance(kept);
  // Nothing kept on this device (a first visit, signed out): the pages before the app are light
  // by default, not whatever the device is set to. A kept answer, dark included, is followed.
  drewLightUnasked = kept === null;
  show(startingAppearance(kept));
  try {
    window.matchMedia(DARK_QUERY).addEventListener("change", () => {
      if (current.theme === "system" && !drewLightUnasked) show(current);
    });
  } catch {
    // No matchMedia: match device stays as it was drawn.
  }
}

/** Applies a change now and saves it behind. A save that fails leaves this device as chosen. */
export function changeAppearance(change: Partial<Appearance>): void {
  set(merged(current, change));
  void saveAppearance(change).catch(() => undefined);
}

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};

/** The one way a component reads the account's look, and changes it. */
export function useAppearance(): { readonly appearance: Appearance; readonly change: (c: Partial<Appearance>) => void } {
  const appearance = useSyncExternalStore(subscribe, () => current, () => DEFAULT_APPEARANCE);
  return { appearance, change: changeAppearance };
}
