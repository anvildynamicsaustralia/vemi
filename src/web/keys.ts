/**
 * The keys. `Cmd/Ctrl K` opens the palette (a second press closes it), `/` opens Search,
 * `?` the shortcuts sheet, `N` a new task, `P` a new project. `G` then `S` is Search. The
 * single keys can all be turned off on this device (`extras.ts`); `Cmd/Ctrl K` and `Esc`
 * stay. `1` and `2` are a venture's two tabs, in the pill's order, on its tabs and on a
 * project's or a task's page inside it, and do nothing outside a venture. `Esc` closes.
 * Nothing fires while a person is typing, except `Esc` and the keys that take a modifier.
 *
 * `G` then a letter goes somewhere from anywhere: `G M` the map, `G A` the archive, `G T`
 * Today. Each is a place the rail or Account already shows, so nothing is reachable only by
 * a key. A second key that is not one of those
 * letters does what it would have done alone, and a lone `Shift` between the two (on the
 * way to a capital) keeps the `G` waiting.
 *
 * Undo takes a modifier: `Cmd/Ctrl Z`, and `Shift` with it (or `Ctrl Y`) to redo. Inside a
 * field those keys are the field's own: they take back the typing, as they do everywhere
 * else, and never reach past it to a card moved minutes ago somewhere else. The app's undo
 * works once the focus leaves the field, and from the Undo and Redo buttons. Search is not
 * like that: no field uses `Cmd/Ctrl K`, so it fires while typing.
 */

import type { Tab } from "./router.js";

/** Where `G` and a letter go. */
export type GoPlace = "map" | "archive" | "today" | "search";

export type KeyAction =
  | { readonly type: "tab"; readonly tab: Tab }
  | { readonly type: "lead" }
  | { readonly type: "go"; readonly place: GoPlace }
  | { readonly type: "palette" }
  | { readonly type: "search" }
  | { readonly type: "help" }
  | { readonly type: "project" }
  | { readonly type: "compose" }
  | { readonly type: "close" }
  | { readonly type: "undo" }
  | { readonly type: "redo" };

export interface KeyLike {
  readonly key: string;
  readonly target: EventTarget | null;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly altKey: boolean;
  readonly shiftKey: boolean;
}

const TAB_KEYS: Readonly<Record<string, Tab>> = { "1": "board", "2": "projects" };
const GO_KEYS: Readonly<Record<string, GoPlace>> = { m: "map", a: "archive", t: "today", s: "search" };
const MODIFIERS: ReadonlySet<string> = new Set(["Shift", "Control", "Alt", "Meta"]);

export function isTyping(target: EventTarget | null): boolean {
  if (target === null || typeof target !== "object" || !("tagName" in target)) return false;
  const el = target as { tagName: string; isContentEditable?: boolean };
  return el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable === true;
}

/** `led`: the key before this one was a lone `G`, a moment ago. */
export function keyAction(event: KeyLike, led = false, singleKeys = true): KeyAction | null {
  const mod = (event.ctrlKey || event.metaKey) && !event.altKey;
  const key = event.key.toLowerCase();
  if (mod && (key === "z" || key === "y") && isTyping(event.target)) return null;
  if (mod && key === "z") return event.shiftKey ? { type: "redo" } : { type: "undo" };
  if (mod && key === "y") return { type: "redo" };
  if (mod && key === "k" && !event.shiftKey) return { type: "palette" };
  if (event.ctrlKey || event.metaKey || event.altKey) return null;
  if (event.key === "Escape") return { type: "close" };
  if (isTyping(event.target)) return null;
  // The switch in Extras: every key below is one press, and all of them go quiet together.
  if (!singleKeys) return null;
  if (event.key === "/") return { type: "search" };
  if (event.key === "?") return { type: "help" };
  const place = led ? GO_KEYS[key] : undefined;
  if (place !== undefined) return { type: "go", place };
  if (key === "g") return { type: "lead" };
  if (key === "n") return { type: "compose" };
  if (key === "p") return { type: "project" };
  const tab = TAB_KEYS[event.key];
  return tab === undefined ? null : { type: "tab", tab };
}

/** Whether this is a Mac, an iPhone or an iPad, whose keyboards say ⌘ rather than Ctrl. */
export function onMac(): boolean {
  return typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
}

/** The keys as the keyboard in front of the person names them, for a hint or a tooltip. */
export function keyNames(mac: boolean): { readonly mod: string; readonly undo: string; readonly redo: string } {
  return mac
    ? { mod: "⌘", undo: "⌘Z", redo: "⇧⌘Z" }
    : { mod: "Ctrl ", undo: "Ctrl+Z", redo: "Ctrl+Shift+Z" };
}

/**
 * When the lead was last pressed, once this key is in: a `G` starts it again, a lone
 * modifier leaves it as it was, and anything else ends it.
 */
export function ledAfter(event: Pick<KeyLike, "key">, action: KeyAction | null, ledAt: number, now: number): number {
  if (action?.type === "lead") return now;
  return MODIFIERS.has(event.key) ? ledAt : 0;
}

/**
 * Whether an overlay (the palette or the shortcuts sheet) being open holds this action back.
 * Esc, Cmd or Ctrl K and undo and redo still work; every single-key action waits, so a key
 * typed over the sheet does not run underneath it.
 */
export function heldByOverlay(action: KeyAction): boolean {
  return action.type !== "close" && action.type !== "palette" && action.type !== "undo" && action.type !== "redo";
}
