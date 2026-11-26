/**
 * The helper's move pieces: the sixth list row, "Copying your stuff", and the fields that
 * hold what the move needs (an email, a password, and the export file when the page was not
 * opened with one). They sit inside the helper's frame (`GetFlow.tsx`); nothing here sends.
 */
import type { ReactElement } from "react";
import { MOVE_ROW, emailProblem, passwordProblem, type RowState } from "../../shared/setup/getFlow.js";
import { moveLines } from "../../shared/moveCounts.js";
import { levelWords, type LevelNames } from "../levelWords.js";
import type { OpenWay } from "../keyWays.js";
import type { GetState } from "./getFlowState.js";

export const MOVE_WORDS = {
  email: "Email",
  password: "A password for your own VEMI",
  passwordHint: "At least 10 characters",
  file: "Your export file",
  line: "This is your VEMI password, not your Cloudflare one. You can use the same email you use here.",
} as const;

/** Handlers the move's fields need. A subset of the page's actions. */
export interface MoveActions {
  typeEmail(text: string): void;
  typePassword(text: string): void;
  pickFile(file: File): void;
  /** One of the file's own ways in, before anything is sent. */
  proveKey(way: OpenWay): void;
}

const names = (raw: Readonly<Record<string, unknown>>): Partial<LevelNames> => {
  const pick = (k: keyof LevelNames): string | undefined => (typeof raw[k] === "string" ? raw[k] : undefined);
  return { space: pick("space"), project: pick("project"), milestone: pick("milestone"), task: pick("task") };
};

/** What came over, as lines in the person's own level names. */
export const countLines = (state: GetState): string[] =>
  state.move.kind === "ok" ? moveLines(state.move.counts, levelWords(names(state.move.levelNames))) : [];

/** The move row's state and note, from state alone. */
export function moveRow(state: GetState): { state: RowState; label: string; note: string } {
  const move = state.move;
  const row: RowState = move.kind === "ok" ? "ok" : move.kind === "working" ? "run" : move.kind === "bad" ? "bad" : "wait";
  const lines = countLines(state);
  return { state: row, label: MOVE_ROW.label, note: move.kind === "ok" && lines.length > 0 ? lines.join(", ") : MOVE_ROW.note };
}

/** The email and password for the new copy. Held in memory by the page, never saved. */
export function MoveLogin({ state, on }: { state: GetState; on: Pick<MoveActions, "typeEmail" | "typePassword"> }): ReactElement {
  const emailBad = state.email !== "" && emailProblem(state.email) !== null;
  const passwordBad = state.password !== "" && passwordProblem(state.password) !== null;
  return (
    <>
      <div className="get-field">
        <label htmlFor="get-email">{MOVE_WORDS.email}</label>
        <input id="get-email" type="email" value={state.email} autoComplete="email" spellCheck={false} aria-invalid={emailBad} onChange={(e) => on.typeEmail(e.target.value)} />
      </div>
      <div className="get-field">
        <label htmlFor="get-password">{MOVE_WORDS.password}</label>
        <input
          id="get-password"
          type="password"
          value={state.password}
          autoComplete="new-password"
          placeholder={MOVE_WORDS.passwordHint}
          aria-invalid={passwordBad}
          onChange={(e) => on.typePassword(e.target.value)}
        />
      </div>
      <p className="get-hint"><span>{MOVE_WORDS.line}</span></p>
    </>
  );
}

/** Whatever the move is still missing, asked for on its own step: the file, then the login. */
export function MoveMissing({ state, on }: { state: GetState; on: MoveActions }): ReactElement | null {
  if (state.move.kind !== "idle") return null;
  const needsLogin = emailProblem(state.email) !== null || passwordProblem(state.password) !== null;
  if (state.hasSource && !needsLogin) return null;
  return (
    <div className="get-missing">
      {!state.hasSource && (
        <div className="get-field">
          <label htmlFor="get-file">{MOVE_WORDS.file}</label>
          <input id="get-file" type="file" accept="application/json,.json" onChange={(e) => { const file = e.target.files?.[0]; if (file !== undefined) on.pickFile(file); }} />
        </div>
      )}
      {needsLogin && <MoveLogin state={state} on={on} />}
    </div>
  );
}
