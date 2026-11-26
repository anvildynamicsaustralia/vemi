import { useId, type InputHTMLAttributes, type ReactNode } from "react";
import { InfoTip } from "./InfoTip.js";
import { Wordmark } from "./Wordmark.js";
import "./gate.css";

/**
 * What the dark side of a gate page says: a headline with one word in the accent, and a line
 * under it. One entry per screen, so a page names its own and the words live in one place.
 */
const SIDES = {
  signIn: { before: "One place for ", accent: "everything", after: " you are building.", text: "Your spaces, projects and tasks, on one map." },
  claim: { before: "Make it ", accent: "yours", after: ".", text: "Your copy, your account." },
  code: { before: "One more ", accent: "step", after: ".", text: "A second check, so only you get in." },
  recover: { before: "Get ", accent: "back", after: " in.", text: "Your recovery code lets you pick a new password." },
  reset: { before: "A new ", accent: "password", after: ".", text: "You will be signed in straight after." },
  invite: { before: "You are ", accent: "invited", after: ".", text: "Pick a password and you are in." },
  shown: { before: "Keep it ", accent: "safe", after: ".", text: "You will only see it this once." },
  inviteOnly: { before: "Invite ", accent: "only", after: ".", text: "New people join by invitation from the owner." },
  consent: { before: "You ", accent: "decide", after: " what it can touch.", text: "Apps you connect can read and change your work. They cannot delete anything." },
  unverified: { before: "Check the ", accent: "site", after: " first.", text: "VEMI could not confirm who this app is, so there is no logo." },
} as const;

export type GateSide = keyof typeof SIDES;

/**
 * The shell of every page a person sees before they are in: a dark panel with the wordmark and
 * a headline, and the page beside it (under it on a phone). Light unless the person chose dark.
 * Only the page scrolls, whole, so a phone held sideways still reaches the top of the form.
 */
export function Gate({ side, title, lede, children }: {
  readonly side: GateSide;
  readonly title: string;
  readonly lede?: ReactNode;
  readonly children?: ReactNode;
}) {
  const words = SIDES[side];
  return (
    <div className="gate">
      <div className="gate-frame">
        <aside className="gate-side">
          <Wordmark className="gate-logo" />
          <div>
            <p className="gate-side-head">{words.before}<em>{words.accent}</em>{words.after}</p>
            <p className="gate-side-text">{words.text}</p>
          </div>
          <small className="gate-made">Made by Anvil Dynamics</small>
        </aside>
        <main className="gate-main">
          <div className="gate-panel">
            <h1 className="gate-title">{title}</h1>
            {lede !== undefined && lede !== null && <p className="gate-lede">{lede}</p>}
            {children}
          </div>
        </main>
      </div>
    </div>
  );
}

/**
 * A labelled field with its helper line and, when it has one, the small "i" note. The label is
 * seen; the input keeps the name it always had for a screen reader and a password manager.
 */
export function Field({ label, aria, tip, help, tone, ...input }: Omit<InputHTMLAttributes<HTMLInputElement>, "id" | "aria-label"> & {
  /** The label shown above the field. */
  readonly label: string;
  /** The accessible name, when it is not the label. */
  readonly aria?: string;
  readonly tip?: { readonly label: string; readonly note: string };
  /** A short line under the field: a rule, or what the code has checked. */
  readonly help?: string | null;
  /** The helper line says something is right, or wrong. */
  readonly tone?: "good" | "bad";
}) {
  const id = useId();
  const helpId = `${id}-help`;
  const hasHelp = help !== undefined && help !== null && help !== "";
  return (
    <div className="gate-field">
      <div className="gate-label">
        <label htmlFor={id}>{label}</label>
        {tip !== undefined && <InfoTip label={tip.label}>{tip.note}</InfoTip>}
      </div>
      <input {...input} id={id} className={`field${input.className === undefined ? "" : ` ${input.className}`}`}
        aria-label={aria ?? label} aria-describedby={hasHelp ? helpId : undefined} />
      {hasHelp && <span id={helpId} className={`gate-help${tone === undefined ? "" : ` ${tone}`}`}>{help}</span>}
    </div>
  );
}
