/**
 * Where this account is in first run, and which tips it has seen, from storage to the page.
 *
 * The Worker keeps both on the account (`/api/first-run`). This module is the one place the web
 * app reads them: `useFirstRun()` in a component. A change applies at once and is saved behind
 * it through the outbox. The last answer is kept on this device so a reload resumes at the same
 * step before the Worker answers; the Worker's answer then replaces it. Same shape as
 * `levelNames.ts`, and like it never throws on storage.
 *
 * `step` null means first run is over or never started; `tipsSeen` null means no tips to show.
 * `known` is false until an answer, kept or fresh, has been read.
 */
import { useSyncExternalStore } from "react";
import { paths, read, saveFirstRunStep, saveTipSeen } from "./api.js";
import { asStep, type FirstRunStep } from "./firstRunSteps.js";

const KEY = "vemi:firstRun:v1";
const TIP_NAME = /^[a-z-]{1,32}$/;
const MOST_TIPS = 20;

export interface FirstRun {
  readonly step: FirstRunStep | null;
  readonly tipsSeen: readonly string[] | null;
  readonly known: boolean;
}

export const UNKNOWN: FirstRun = { step: null, tipsSeen: null, known: false };

/** The state in an unknown answer: a step only when it is one of the seven, tips only as a list of names. */
export function readFirstRun(answer: unknown): FirstRun {
  if (typeof answer !== "object" || answer === null || Array.isArray(answer)) return UNKNOWN;
  const src = answer as Record<string, unknown>;
  const tips = src["tipsSeen"];
  const tipsSeen = Array.isArray(tips)
    ? tips.filter((t): t is string => typeof t === "string" && TIP_NAME.test(t)).slice(0, MOST_TIPS)
    : null;
  return { step: asStep(src["step"]), tipsSeen, known: true };
}

export const toStoredFirstRun = (s: FirstRun): string => JSON.stringify({ step: s.step, tipsSeen: s.tipsSeen });

/** The copy kept on this device, out of a stored string, whatever it turns out to be. */
export function storedFirstRun(raw: string | null): FirstRun {
  if (raw === null) return UNKNOWN;
  try {
    return readFirstRun(JSON.parse(raw));
  } catch {
    return UNKNOWN;
  }
}

/** This state with the step changed. */
export const withStep = (s: FirstRun, step: FirstRunStep | null): FirstRun => ({ ...s, step, known: true });

/** This state with a tip marked seen: appended once, at most 20 kept, ignored when there are no tips to show. */
export function withTipSeen(s: FirstRun, name: string): FirstRun {
  if (s.tipsSeen === null || !TIP_NAME.test(name) || s.tipsSeen.includes(name)) return s;
  return { ...s, tipsSeen: [...s.tipsSeen, name].slice(-MOST_TIPS) };
}

/** True when the named tip should show now: the account has tips to show and has not seen this one. */
export const tipDue = (s: FirstRun, name: string): boolean =>
  s.known && s.tipsSeen !== null && !s.tipsSeen.includes(name);

function kept(): FirstRun {
  try {
    return storedFirstRun(localStorage.getItem(KEY));
  } catch {
    return UNKNOWN;
  }
}

let current: FirstRun = kept();
const listeners = new Set<() => void>();

function set(next: FirstRun): void {
  current = next;
  try {
    localStorage.setItem(KEY, toStoredFirstRun(next));
  } catch {
    // Storage refused: the page still shows it, and the account still has it.
  }
  for (const listener of listeners) listener();
}

/** The state now, outside a component. */
export const firstRunNow = (): FirstRun => current;

/** Moves to a step, or ends first run with null. Applies at once and saves behind. */
export function changeFirstRunStep(step: FirstRunStep | null): void {
  set(withStep(current, step));
  void saveFirstRunStep(step).catch(() => undefined);
}

/** Marks a tip seen. Applies at once and saves behind; a tip already seen or not due is not sent. */
export function markTipSeen(name: string): void {
  const next = withTipSeen(current, name);
  if (next === current) return;
  set(next);
  void saveTipSeen(name).catch(() => undefined);
}

/** The Worker's answer, if it will give one. A signed-out page or no connection keeps what it has. */
export async function refreshFirstRun(): Promise<void> {
  try {
    const answer = await read<unknown>(paths.firstRun);
    const next = readFirstRun(answer.data);
    if (toStoredFirstRun(next) !== toStoredFirstRun(current) || !current.known) set(next);
  } catch {
    // Not signed in yet, or unreachable: the copy on this device stands.
  }
}

/** Forgets the copy on this device, for a different account signing in. */
export function forgetFirstRun(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    // Storage refused: nothing kept to forget.
  }
  current = UNKNOWN;
  for (const listener of listeners) listener();
}

/** The one way a component reads first run. */
export function useFirstRun(): FirstRun {
  return useSyncExternalStore(
    (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    () => current,
    () => UNKNOWN,
  );
}
