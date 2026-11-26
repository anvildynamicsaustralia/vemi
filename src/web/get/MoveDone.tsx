/**
 * What the Done screen adds after a move: the real counts, Open my VEMI as the hand-over link,
 * Put it on my home screen, and the one line about reminders. The recovery code the new copy
 * made is shown here once, from memory; it is never saved.
 */
import type { ReactElement } from "react";
import { Icon } from "@vemi/icons";
import type { GetState } from "./getFlowState.js";
import { countLines } from "./MoveBuild.js";

export const MOVE_DONE_WORDS = {
  open: "Open my VEMI",
  home: "Put it on my home screen",
  reminders: "Turn reminders on again in your new VEMI. Each device asks once.",
  recovery: "Your recovery code",
  old: "Your old account is untouched. You can delete it from Account whenever you like.",
} as const;

/** The link Open my VEMI follows: the hand-over link after a move, the plain address otherwise. */
export const openLinkFor = (state: GetState): string => (state.move.kind === "ok" ? state.move.openLink : (state.address ?? ""));

export function MoveDone({ state }: { state: GetState }): ReactElement | null {
  if (state.move.kind !== "ok") return null;
  const lines = countLines(state);
  const link = openLinkFor(state);
  return (
    <>
      {lines.length > 0 && <div className="get-counts">{lines.map((line) => <span key={line}>{line}</span>)}</div>}
      <div className="get-acts">
        <a className="get-primary" href={link}>{MOVE_DONE_WORDS.open} <Icon name="lucide:external-link" size={18} /></a>
        <a className="get-secondary" href={link}>{MOVE_DONE_WORDS.home}</a>
      </div>
      <p className="get-hint"><Icon name="lucide:lock" size={16} /><span>{MOVE_DONE_WORDS.reminders}</span></p>
      {state.fromOld && <p className="get-hint"><Icon name="lucide:check" size={16} /><span>{MOVE_DONE_WORDS.old}</span></p>}
      <p className="get-recovery"><b>{MOVE_DONE_WORDS.recovery}</b> <code>{state.move.recoveryCode}</code></p>
    </>
  );
}
