import { useSyncExternalStore } from "react";
import { EXTRA_SWITCHES, parse, type ExtraSwitch, type ExtraSwitches, type SmartParse } from "@vemi/shared";
import { saveExtras } from "./api.js";

/**
 * The Extras switches, kept on this device. Smart dates is on unless the one key says "off";
 * the account phase draws the Extras section over the same key. A browser that will not say
 * leaves the switch on.
 */
export const SMART_DATES_KEY = "vemi:smartDates:v1";

type Reader = Pick<Storage, "getItem">;

function deviceStore(): Reader | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/** Whether titles are read for dates, repeats and times. */
export function smartDatesOn(store: Reader | null = deviceStore()): boolean {
  try {
    return store?.getItem(SMART_DATES_KEY) !== "off";
  } catch {
    return true;
  }
}

/**
 * The single-key switch, kept on this device. On unless the one key says "off": then `/`, `N`,
 * `P`, `?`, `1`, `2` and `G` with a letter do nothing, while `Cmd/Ctrl K` and `Esc` still work.
 */
export const SINGLE_KEYS_KEY = "vemi:singleKeys:v1";

/** Whether the keys that are one press (and `G` and a letter) are live. */
export function singleKeysOn(store: Reader | null = deviceStore()): boolean {
  try {
    return store?.getItem(SINGLE_KEYS_KEY) !== "off";
  } catch {
    return true;
  }
}

/**
 * All six switches. The account keeps them (`extras` on `/api/appearance`, each on unless
 * switched off); this device keeps a copy under one key each, written whenever the account's
 * answer or a touch changes them, so the first paint and the shipped readers above already
 * know. Smart dates and single keys keep the keys they always had.
 */
export const EXTRA_KEYS: Readonly<Record<ExtraSwitch, string>> = {
  smartDates: SMART_DATES_KEY,
  singleKeys: SINGLE_KEYS_KEY,
  recent: "vemi:recent:v1",
  rings: "vemi:rings:v1",
  comingUp: "vemi:comingUp:v1",
  burst: "vemi:burst:v1",
};

/** Whether one switch is on, from this device's copy. A browser that will not say leaves it on. */
export function extraOn(name: ExtraSwitch, store: Reader | null = deviceStore()): boolean {
  try {
    return store?.getItem(EXTRA_KEYS[name]) !== "off";
  } catch {
    return true;
  }
}

/** The six switches in an unknown answer: on, unless the account said false. */
export function readExtras(input: unknown): ExtraSwitches {
  const src = typeof input === "object" && input !== null && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
  const on = (name: ExtraSwitch): boolean => src[name] !== false;
  return {
    smartDates: on("smartDates"), singleKeys: on("singleKeys"), recent: on("recent"),
    rings: on("rings"), comingUp: on("comingUp"), burst: on("burst"),
  };
}

/** Writes the device copy: "off" for a switch that is off, no key for one that is on. Never throws. */
export function keepExtras(extras: ExtraSwitches, store: Pick<Storage, "setItem" | "removeItem"> | null = deviceWriter()): void {
  for (const name of EXTRA_SWITCHES) {
    try {
      if (extras[name]) store?.removeItem(EXTRA_KEYS[name]);
      else store?.setItem(EXTRA_KEYS[name], "off");
    } catch {
      // The switch still holds for this visit.
    }
  }
}

function deviceWriter(): Pick<Storage, "setItem" | "removeItem"> | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

const deviceExtras = (): ExtraSwitches => ({
  smartDates: extraOn("smartDates"), singleKeys: extraOn("singleKeys"), recent: extraOn("recent"),
  rings: extraOn("rings"), comingUp: extraOn("comingUp"), burst: extraOn("burst"),
});

let current: ExtraSwitches = deviceExtras();
const listeners = new Set<(e: ExtraSwitches) => void>();

/** The switches now. */
export const currentExtras = (): ExtraSwitches => current;

/** Applies the switches now and keeps them on this device. Does not save to the account. */
export function setExtras(next: ExtraSwitches, store: Pick<Storage, "setItem" | "removeItem"> | null = deviceWriter()): void {
  current = next;
  keepExtras(next, store);
  for (const listener of listeners) listener(next);
}

/** Calls back on every change; returns the way to stop. */
export function onExtras(listener: (e: ExtraSwitches) => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** One switch, now, saved behind. A save that fails leaves this device as chosen. */
export function changeExtra(name: ExtraSwitch, on: boolean): void {
  setExtras({ ...current, [name]: on });
  void saveExtras({ [name]: on }).catch(() => undefined);
}

/** The one way a component reads the switches. */
export function useExtras(): ExtraSwitches {
  return useSyncExternalStore(
    (listener) => onExtras(listener),
    () => current,
    () => ALL_ON,
  );
}

const ALL_ON: ExtraSwitches = readExtras(null);

/** `parse`, unless the switch is off: then the text comes back unchanged, understood as nothing. */
export function readSmartDates(text: string, now: Date, timeZone: string, store: Reader | null = deviceStore()): SmartParse {
  if (!smartDatesOn(store)) return { title: text, when: null, repeat: null, remindAt: null, tokens: [] };
  return parse(text, now, timeZone);
}
