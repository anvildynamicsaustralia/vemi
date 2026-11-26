/**
 * Undo, because drag exists. Decision 20, and the rule beside it: drag and undo land
 * together or not at all.
 *
 * A step carries its own way back and its own way forward, because only the caller knows
 * what it just did. Nothing here talks to the Worker: this is the bookkeeping, pure and
 * tested, and `App.tsx` runs the halves.
 *
 * Redo is dropped the moment something new is done, which is what every editor does and
 * what stops a redo from putting back a world that no longer exists.
 */

export interface Step {
  /** Named for the notice: "Put the order back." takes "moved VEMI" and says it. */
  readonly what: string;
  undo(): Promise<unknown>;
  redo(): Promise<unknown>;
}

export interface Undo {
  readonly done: readonly Step[];
  readonly undone: readonly Step[];
}

/** Deep enough for a session's mistakes, shallow enough that nothing is held for ever. */
export const LIMIT = 50;

export const NOTHING: Undo = { done: [], undone: [] };

export const canUndo = (u: Undo): boolean => u.done.length > 0;
export const canRedo = (u: Undo): boolean => u.undone.length > 0;

/** The next thing undo would put back, for a label that says what it is. */
export const nextUndo = (u: Undo): Step | null => u.done.at(-1) ?? null;
export const nextRedo = (u: Undo): Step | null => u.undone.at(-1) ?? null;

export function did(u: Undo, step: Step): Undo {
  return { done: [...u.done, step].slice(-LIMIT), undone: [] };
}

/**
 * The step to run, and where the stack stands once it has. `null` when there is nothing.
 *
 * `only` is for a notice's Undo, which names one step: "Moved to Done · Undo". It runs that
 * step or nothing. Whatever is on top of the stack by the time it is pressed may be some
 * other write entirely, and the press was not for that one.
 */
export function undoing(u: Undo, only?: Step): { readonly next: Undo; readonly step: Step | null } {
  const step = nextUndo(u);
  if (step === null || (only !== undefined && step !== only)) return { next: u, step: null };
  return { next: { done: u.done.slice(0, -1), undone: [...u.undone, step] }, step };
}

export function redoing(u: Undo, only?: Step): { readonly next: Undo; readonly step: Step | null } {
  const step = nextRedo(u);
  if (step === null || (only !== undefined && step !== only)) return { next: u, step: null };
  return { next: { done: [...u.done, step], undone: u.undone.slice(0, -1) }, step };
}

/**
 * A step that failed half-way is not on the stack at all.
 *
 * Undo asked the Worker to put something back and the Worker refused. Leaving the step on
 * `undone` would offer a redo of a thing that never came undone; putting it back on `done`
 * would offer to undo it twice. It goes.
 */
export function forget(u: Undo, step: Step): Undo {
  return { done: u.done.filter((s) => s !== step), undone: u.undone.filter((s) => s !== step) };
}

/**
 * What undo or redo says once it has run, so a keyboard undo on a page with no Undo button
 * does not change things in silence: "Undid: moved Glaze to Done." A way back this device
 * kept says that too, in `kept`'s words.
 */
export const saidFor = (way: "undo" | "redo", step: Step, kept: string | null): string =>
  `${way === "undo" ? "Undid" : "Redid"}: ${step.what}.${kept === null ? "" : ` ${kept}`}`;
