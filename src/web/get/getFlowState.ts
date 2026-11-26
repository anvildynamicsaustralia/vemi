/**
 * The setup page's state and the one function that moves it. Pure: the page's effects (the key
 * check, the name check, the build, the hand-over) dispatch what they found, and this decides
 * what the screen shows. `toSaved` is all that is kept for a reopened tab: the step, the name
 * and the address. The key is held in this state, in memory, and nowhere else (ruling R7).
 */
import type { LockedHeld } from "../moveLocked.js";
import { STEP_NAMES, type StepName } from "../../shared/setup/buildSteps.js";
import {
  DEFAULT_NAME, afterKey, buildFinished, emailProblem, nameFrom, nameProblem, needsKey, passwordProblem, resumeAt, stepAfter,
  stepBefore, type BuildProgress, type FlowStep, type Saved,
} from "../../shared/setup/getFlow.js";

export type KeyCheck =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "ok"; accountId: string; accountName: string }
  | { kind: "bad"; reason: string };

export type NameCheck =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "ok"; address: string }
  | { kind: "bad"; reason: string };

export type Finish = { kind: "idle" } | { kind: "working" } | { kind: "bad"; reason: string };

/** What the move to the new copy brought over, kept only for the Done screen. Memory only. */
export interface MoveDoneState {
  counts: Readonly<Record<string, number>>;
  recoveryCode: string;
  openLink: string;
  levelNames: Readonly<Record<string, unknown>>;
  /** Old row id to new row id, as the new copy answered. Kept for a finishing pass; empty when nothing was locked. */
  ids?: Readonly<Record<string, string>>;
  /** How many locked or encrypted cells the file held. More than none means the new copy has finishing to do. */
  locked?: number;
}

export type MoveState =
  | { kind: "idle" }
  | { kind: "working" }
  | { kind: "bad"; reason: string; final?: true }
  /** The file holds locked content: one of its own ways in opens its key before anything is sent. */
  | { kind: "key"; keys: LockedHeld["keys"]; reason: string | null }
  | ({ kind: "ok" } & MoveDoneState);

export interface GetState {
  /** There is something to copy into the new copy: a source was given, or a closed tab was at the move. */
  withMove: boolean;
  /** The page holds the export to copy now. Without it the move step asks for the file. */
  hasSource: boolean;
  /** The page was opened by an old account's card, so the file is the one the person exported there. */
  fromOld: boolean;
  /** The email and password for the new copy, from the name step. Memory only, never saved. */
  email: string;
  password: string;
  move: MoveState;
  step: FlowStep;
  /** What is typed in the paste box. Memory only. */
  key: string;
  keyCheck: KeyCheck;
  /** What is typed in the name box; the copy's name is `nameFrom` of it. */
  name: string;
  nameCheck: NameCheck;
  /** The new copy's address, once the build has one. */
  address: string | null;
  build: BuildProgress & { reason: string | null; started: boolean };
  keepUpdated: boolean;
  finish: Finish;
  /** Where Next on the permission step goes after a closed tab. */
  resumeTo: FlowStep | null;
  /** The person opened Cloudflare's sign-up in a new tab. */
  signUpOpened: boolean;
  /** Set on Done: the key was left to the copy, or is the person's to take away by hand. */
  kept: boolean | null;
}

export type Action =
  | { type: "go"; step: FlowStep }
  | { type: "next" }
  | { type: "back" }
  | { type: "signUpOpened" }
  | { type: "keyTyped"; key: string }
  | { type: "keyChecking" }
  | { type: "keyChecked"; key: string; check: KeyCheck }
  | { type: "nameTyped"; name: string }
  | { type: "nameChecking" }
  | { type: "nameChecked"; name: string; check: NameCheck }
  | { type: "buildStarted" }
  | { type: "buildStep"; step: StepName; state: "start" | "skipped" | "done" | "failed" }
  | { type: "buildFailed"; step: StepName | null; reason: string }
  | { type: "buildDone"; address: string }
  | { type: "emailTyped"; email: string }
  | { type: "passwordTyped"; password: string }
  | { type: "sourceChosen" }
  | { type: "moveNeedsKey"; keys: LockedHeld["keys"] }
  | { type: "keyProved" }
  | { type: "keyFailed"; reason: string }
  | { type: "moveStarted" }
  | { type: "moveReset" }
  | { type: "moveFailed"; reason: string; final?: true }
  | ({ type: "moveDone" } & MoveDoneState)
  | { type: "keepUpdated"; on: boolean }
  | { type: "finishing" }
  | { type: "finishFailed"; reason: string }
  | { type: "finished"; kept: boolean };

const IDLE_BUILD: GetState["build"] = { done: [], running: null, failed: null, reason: null, started: false };

/** `hasSource`: the page was opened with something to copy. A closed tab saved at the move resumes there either way. */
export function initial(saved: Saved | null, hasSource = false, fromOld = false, fromLocal = false): GetState {
  const step = resumeAt(saved, false);
  const atMove = saved?.step === "move";
  return {
    withMove: hasSource || atMove || fromOld || fromLocal,
    hasSource,
    fromOld,
    email: "",
    password: "",
    move: { kind: "idle" },
    step,
    key: "",
    keyCheck: { kind: "idle" },
    name: saved?.name !== undefined && saved.name !== "" ? saved.name : DEFAULT_NAME,
    nameCheck: { kind: "idle" },
    address: saved?.address ?? null,
    // Behind a saved move step the build is already whole; the copy has an address.
    build: atMove ? { ...IDLE_BUILD, done: STEP_NAMES } : IDLE_BUILD,
    keepUpdated: true,
    finish: { kind: "idle" },
    resumeTo: saved !== null && needsKey(saved.step) ? afterKey(saved) : null,
    signUpOpened: false,
    kept: null,
  };
}

/** Whether the email and password for the new copy are fit to send. */
export const hasLogin = (state: GetState): boolean => emailProblem(state.email) === null && passwordProblem(state.password) === null;

/** Whether the move can start now: a login, the file in hand, and not already done or running. */
export const canMove = (state: GetState): boolean =>
  state.step === "move" && state.hasSource && hasLogin(state) && (state.move.kind === "idle");

/** Whether Next is available on the step being shown. */
export function canGoNext(state: GetState): boolean {
  switch (state.step) {
    case "account":
      return true;
    case "permission":
      return state.keyCheck.kind === "ok";
    case "name":
      return state.nameCheck.kind === "ok" && nameProblem(state.name) === null && (!state.withMove || hasLogin(state));
    case "build":
      return buildFinished(state.build);
    case "move":
      return state.move.kind === "ok";
    case "update":
      return state.finish.kind !== "working";
    case "done":
      return false;
  }
}

/** The account's name, once the key is checked. */
export const accountName = (state: GetState): string | null => (state.keyCheck.kind === "ok" ? state.keyCheck.accountName : null);

/** What a closed tab keeps. Nothing from here is secret: the key and the claim code are not in it. */
export function toSaved(state: GetState): Saved {
  return { step: state.step, name: nameFrom(state.name) === "" ? DEFAULT_NAME : state.name, address: state.address };
}

const without = (list: readonly StepName[], step: StepName): StepName[] => list.filter((s) => s !== step);

export function reduce(state: GetState, action: Action): GetState {
  switch (action.type) {
    case "go":
      return { ...state, step: action.step };
    case "next": {
      if (!canGoNext(state)) return state;
      // After a closed tab the key step goes back to where the tab was.
      if (state.step === "permission" && state.resumeTo !== null) return { ...state, step: state.resumeTo, resumeTo: null };
      return { ...state, step: stepAfter(state.step, state.withMove) };
    }
    case "back":
      return { ...state, step: stepBefore(state.step, state.withMove) };
    case "signUpOpened":
      return { ...state, signUpOpened: true };

    case "keyTyped": {
      const key = action.key.trim();
      // A changed key forgets what the last one proved, and the steps that rested on it.
      return { ...state, key, keyCheck: key === "" ? { kind: "idle" } : { kind: "checking" } };
    }
    case "keyChecking":
      return { ...state, keyCheck: { kind: "checking" } };
    case "keyChecked":
      // An answer for a key that is no longer in the box is not for this screen.
      return action.key === state.key ? { ...state, keyCheck: action.check } : state;

    case "nameTyped":
      return { ...state, name: action.name, nameCheck: nameProblem(action.name) === null ? { kind: "checking" } : { kind: "bad", reason: nameProblem(action.name) ?? "" } };
    case "nameChecking":
      return { ...state, nameCheck: { kind: "checking" } };
    case "nameChecked":
      return nameFrom(action.name) === nameFrom(state.name) ? { ...state, nameCheck: action.check } : state;

    case "buildStarted":
      return { ...state, build: { ...state.build, running: null, failed: null, reason: null, started: true } };
    case "buildStep": {
      const { step, state: what } = action;
      if (what === "start") return { ...state, build: { ...state.build, running: step, failed: null, reason: null } };
      if (what === "failed") return { ...state, build: { ...state.build, running: null, failed: step, done: without(state.build.done, step) } };
      const done = state.build.done.includes(step) ? state.build.done : [...state.build.done, step];
      return { ...state, build: { ...state.build, done, running: state.build.running === step ? null : state.build.running } };
    }
    case "buildFailed":
      return { ...state, build: { ...state.build, running: null, failed: action.step ?? state.build.failed, reason: action.reason } };
    case "buildDone":
      return { ...state, address: action.address, build: { ...state.build, running: null, failed: null, reason: null } };

    case "emailTyped":
      return { ...state, email: action.email.trim(), move: state.move.kind === "bad" ? { kind: "idle" } : state.move };
    case "passwordTyped":
      return { ...state, password: action.password, move: state.move.kind === "bad" ? { kind: "idle" } : state.move };
    case "sourceChosen":
      return { ...state, hasSource: true, move: state.move.kind === "bad" ? { kind: "idle" } : state.move };
    case "moveNeedsKey":
      return { ...state, move: { kind: "key", keys: action.keys, reason: null } };
    case "keyProved":
      return state.move.kind === "key" ? { ...state, move: { kind: "idle" } } : state;
    case "keyFailed":
      return state.move.kind === "key" ? { ...state, move: { ...state.move, reason: action.reason } } : state;
    case "moveStarted":
      return { ...state, move: { kind: "working" } };
    case "moveReset":
      return { ...state, move: { kind: "idle" } };
    case "moveFailed":
      return { ...state, move: { kind: "bad", reason: action.reason, ...(action.final === true ? { final: true as const } : {}) } };
    case "moveDone": {
      const { counts, recoveryCode, openLink, levelNames, ids, locked } = action;
      // The login has done its work here; the page lets go of it.
      return { ...state, email: "", password: "", move: { kind: "ok", counts, recoveryCode, openLink, levelNames, ids, locked } };
    }

    case "keepUpdated":
      return { ...state, keepUpdated: action.on };
    case "finishing":
      return { ...state, finish: { kind: "working" } };
    case "finishFailed":
      return { ...state, finish: { kind: "bad", reason: action.reason } };
    case "finished":
      // The key has done its work here; the page lets go of it.
      return { ...state, finish: { kind: "idle" }, kept: action.kept, step: "done", key: "", keyCheck: { kind: "idle" } };
  }
}
