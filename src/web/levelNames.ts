/**
 * What this account calls its four levels, from storage to the page.
 *
 * The Worker keeps the names on the account (`/api/appearance`, `levelNames`). This module is
 * the one place the web app reads them: `useLevelWords()` in a component, `currentWords()`
 * outside one. A change applies at once and is saved behind it. The last answer is kept on
 * this device so the first paint already wears the right words; the Worker's answer then
 * replaces it. Same shape as `appearance.ts`, and like it never throws on storage.
 */
import { useEffect, useSyncExternalStore } from "react";
import { paths, read, saveLevelNames } from "./api.js";
import { DEFAULT_LEVEL_NAMES, levelWords, type LevelNames, type LevelWords } from "./levelWords.js";

const KEY = "vemi:levelNames:v1";
const LEVELS = ["space", "project", "milestone", "task"] as const;

const usable = (v: unknown): v is string => typeof v === "string" && v.trim() !== "";

/** The four names inside an unknown object, the shipped word for each it cannot use. */
function fromObject(src: unknown): LevelNames {
  const o = typeof src === "object" && src !== null && !Array.isArray(src) ? (src as Record<string, unknown>) : {};
  const pick = (level: (typeof LEVELS)[number]): string => {
    const v = o[level];
    return usable(v) ? v.trim() : DEFAULT_LEVEL_NAMES[level];
  };
  return { space: pick("space"), project: pick("project"), milestone: pick("milestone"), task: pick("task") };
}

/** The names in the account's answer (the settings object). */
export function readLevelNames(answer: unknown): LevelNames {
  if (typeof answer !== "object" || answer === null) return DEFAULT_LEVEL_NAMES;
  return fromObject((answer as Record<string, unknown>)["levelNames"]);
}

export const toStoredNames = (n: LevelNames): string => JSON.stringify(n);

/** The copy kept on this device, out of a stored string, whatever it turns out to be. */
export function storedLevelNames(raw: string | null): LevelNames {
  if (raw === null) return DEFAULT_LEVEL_NAMES;
  try {
    return fromObject(JSON.parse(raw));
  } catch {
    return DEFAULT_LEVEL_NAMES;
  }
}

function keptNames(): LevelNames {
  try {
    return storedLevelNames(localStorage.getItem(KEY));
  } catch {
    return DEFAULT_LEVEL_NAMES;
  }
}

let names: LevelNames = keptNames();
let words: LevelWords = levelWords(names);
const listeners = new Set<() => void>();

/** Puts names on the page and keeps them on this device. Does not save to the account. */
export function setLevelNames(next: LevelNames): void {
  names = next;
  words = levelWords(next);
  try {
    localStorage.setItem(KEY, toStoredNames(next));
  } catch {
    // Storage refused: the page still shows it, and the account still has it.
  }
  for (const listener of listeners) listener();
}

/** The names now in use, singular, as typed. */
export const currentNames = (): LevelNames => names;

/** The words now in use, singular and plural. For code that is not a component. */
export const currentWords = (): LevelWords => words;

let asked = false;

/** The Worker's answer, if it will give one. A signed-out page or no connection keeps what it has. */
export async function refreshLevelNames(): Promise<void> {
  const seen = names;
  try {
    const answer = await read<unknown>(paths.appearance);
    // Names changed here while the answer was on its way: that edit is newer, so it stands.
    if (names !== seen) return;
    const next = readLevelNames(answer.data);
    if (toStoredNames(next) !== toStoredNames(names)) setLevelNames(next);
  } catch {
    // Not signed in yet, or unreachable: the copy on this device stands.
  }
}

/** Applies a change to the names now and saves it behind. Null puts a level back to its shipped word. */
export function changeLevelNames(change: Partial<LevelNames>): void {
  setLevelNames({ ...names, ...change });
  const body: Record<string, string | null> = {};
  for (const level of LEVELS) {
    const given = change[level];
    if (given !== undefined) body[level] = given.trim() === DEFAULT_LEVEL_NAMES[level] ? null : given.trim();
  }
  void saveLevelNames(body).catch(() => undefined);
}

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};

/** The one way a component reads the account's words. Asks the account once, on first use. */
export function useLevelWords(): LevelWords {
  useEffect(() => {
    if (asked) return;
    asked = true;
    void refreshLevelNames();
  }, []);
  return useSyncExternalStore(subscribe, () => words, () => words);
}
