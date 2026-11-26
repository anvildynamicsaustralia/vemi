import { createContext, useContext, useSyncExternalStore } from "react";
import type { DateOnly, Kind } from "@vemi/shared";
import { paths, read, saveNewTaskVenture, type Input } from "../api.js";
import type { Prefill } from "../newTask.js";
import type { Outcome } from "../outcome.js";
import type { Step } from "../undo.js";
import type { MenuItem } from "./Menu.js";

/**
 * What a new task starts with. Everything is optional; compose asks for a title and a venture.
 * The pre-fill is the same value an in-place add makes its task from (`newTask.ts`).
 */
export interface ComposeSeed extends Prefill {
  readonly title?: string;
  /** Text carried with the title, such as the link a share sheet handed over. */
  readonly body?: string;
  /** Opened from today, where a new task is almost always meant for today. */
  readonly onToday?: boolean;
}

export interface IconTarget {
  readonly kind: "ventures" | "projects";
  readonly id: string;
  readonly label: string;
  readonly current: string | null;
}

/** A project about to be moved inside another, or out of one. */
export interface HomeTarget {
  readonly id: string;
  readonly ventureId: string;
  readonly label: string;
}

export interface AppActions {
  /** Today's date in the owner's time zone, as the Worker says. Null until it has said. */
  readonly today: DateOnly | null;
  readonly phone: boolean;
  openTask(id: string | null): void;
  compose(seed?: ComposeSeed): void;
  search(): void;
  pickIcon(target: IconTarget): void;
  /** Open the sheet that moves a project inside another, or back out. */
  pickHome(target: HomeTarget): void;
  /**
   * Say something in the notice. `undo` puts the handoff's UNDO on it, for a message about a
   * write that has just gone on the undo stack: that write's step, and only that one.
   */
  notify(message: string, options?: { readonly undo?: boolean }): void;
  /**
   * Run a write. Says what happened if it did not simply work, and answers what became of
   * it: `"sent"`, `"kept"` on this device until there is a connection (already said, so a
   * caller says nothing over it), or `false` when it did not happen.
   *
   * A write that can be taken back passes the `step` that takes it back; it goes on the
   * undo stack only once the write has answered, so undo never offers to reverse a write
   * that never happened. Decision 20.
   */
  act(work: () => Promise<unknown>, step?: Step): Promise<Outcome>;
  /**
   * Change fields of one record, undoably: the way back is those fields as `current` has
   * them, read before the write is sent. `what` names it on the stack: "renamed the project".
   * A text field passes what it had on screen, not the record, which can be a save behind it.
   */
  edit(kind: Kind, id: string, fields: Input, current: object, what: string): Promise<Outcome>;
  undo(): void;
  redo(): void;
  /**
   * What a phone hides and every page's ⋯ carries there (VEMI-007): the needs-you list, and
   * what the status line would have said. Empty on a desk, where both are on screen.
   */
  readonly phoneMenu: readonly MenuItem[];
  /** Archive a record, and offer to undo it. `what` names it in the notice: "task", "note". */
  archive(kind: Kind, id: string, what: string): Promise<boolean>;
}

export const AppContext = createContext<AppActions | null>(null);

/**
 * What undo would put back, and what redo would do again. Null when there is nothing. Apart
 * from the actions, so a write going on the stack redraws what reads it and not everything
 * that holds an action.
 */
export interface UndoState {
  readonly undoable: string | null;
  readonly redoable: string | null;
}

export const UndoContext = createContext<UndoState>({ undoable: null, redoable: null });


export function useApp(): AppActions {
  const actions = useContext(AppContext);
  if (actions === null) throw new Error("useApp is only for components inside the app");
  return actions;
}

const LAST_VENTURE = "vemi:last-venture:v1";

export function lastVenture(): string | null {
  try {
    return localStorage.getItem(LAST_VENTURE);
  } catch {
    return null;
  }
}

export function rememberVenture(id: string): void {
  try {
    localStorage.setItem(LAST_VENTURE, id);
  } catch {
    // Forgotten on reload, then.
  }
}

/**
 * The setting "New tasks go to": a space, or null for the space used last. The account keeps
 * it; the copy on this device is what the page draws from before the account answers, and
 * what holds when it cannot be reached.
 */
const NEW_TASK_VENTURE = "vemi:new-task-venture:v1";

function keptNewTaskVenture(): string | null {
  try {
    const kept = localStorage.getItem(NEW_TASK_VENTURE);
    return kept === null || kept === "" ? null : kept;
  } catch {
    return null;
  }
}

let newTaskChoice: string | null = keptNewTaskVenture();
const newTaskListeners = new Set<() => void>();

function setNewTaskChoice(id: string | null): void {
  if (id === newTaskChoice) return;
  newTaskChoice = id;
  try {
    localStorage.setItem(NEW_TASK_VENTURE, id ?? "");
  } catch {
    // The account still has it.
  }
  for (const listener of newTaskListeners) listener();
}

/** The space chosen for new tasks, or null when the choice is "the space I used last". */
export const newTaskVenture = (): string | null => newTaskChoice;

/** Where an add with no space named goes: the chosen space, else the one used last. */
export const homeVentureId = (): string | null => newTaskChoice ?? lastVenture();

/** Chooses the space new tasks go to, or null for the one used last. Applied now, saved behind. */
export function chooseNewTaskVenture(id: string | null): void {
  setNewTaskChoice(id);
  void saveNewTaskVenture(id).catch(() => undefined);
}

/** The account's answer, if it will give one. Not signed in or unreachable keeps what this device has. */
export async function refreshNewTaskVenture(): Promise<void> {
  try {
    const answer = await read<unknown>(paths.appearance);
    const data = answer.data;
    if (typeof data !== "object" || data === null || !("newTaskVentureId" in data)) return;
    const id = (data as { newTaskVentureId: unknown }).newTaskVentureId;
    setNewTaskChoice(typeof id === "string" && id !== "" ? id : null);
  } catch {
    // Not signed in yet, or unreachable: the copy on this device stands.
  }
}

const subscribeNewTask = (listener: () => void): (() => void) => {
  newTaskListeners.add(listener);
  return () => { newTaskListeners.delete(listener); };
};

/** The chosen space for new tasks, kept current as it changes. */
export function useNewTaskVenture(): string | null {
  return useSyncExternalStore(subscribeNewTask, newTaskVenture, () => null);
}
