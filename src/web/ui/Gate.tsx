import { useId, useState, type InputHTMLAttributes, type KeyboardEvent, type ReactNode } from "react";
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
export function Gate({ side, title, lede, where, children }: {
  readonly side: GateSide;
  readonly title: string;
  readonly lede?: ReactNode;
  /** Which copy this is, said under the title: the address, so nobody signs in to the wrong one. */
  readonly where?: string;
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
            {where !== undefined && <p className="gate-where"><span className="gate-where-dot" aria-hidden="true" />{where}</p>}
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
export function Field({ label, aria, tip, help, tone, aside, ...input }: Omit<InputHTMLAttributes<HTMLInputElement>, "id" | "aria-label"> & {
  /** The label shown above the field. */
  readonly label: string;
  /** The accessible name, when it is not the label. */
  readonly aria?: string;
  readonly tip?: { readonly label: string; readonly note: string };
  /** A short line under the field: a rule, or what the code has checked. */
  readonly help?: string | null;
  /** The helper line says something is right, or wrong. */
  readonly tone?: "good" | "bad";
  /** A link at the far end of the label row, such as "Forgot password?". */
  readonly aside?: ReactNode;
}) {
  const id = useId();
  const helpId = `${id}-help`;
  const secret = input.type === "password";
  const [shown, setShown] = useState(false);
  const [caps, setCaps] = useState(false);
  // A password field says when Caps Lock is on, the commonest reason a right password is refused.
  const watchCaps = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (secret) setCaps(e.getModifierState?.("CapsLock") === true);
  };
  const line = caps ? "Caps Lock is on." : help;
  const hasHelp = line !== undefined && line !== null && line !== "";
  const field = (
    <input {...input} type={secret && shown ? "text" : input.type} id={id}
      className={`field${input.className === undefined ? "" : ` ${input.className}`}`}
      aria-label={aria ?? label} aria-describedby={hasHelp ? helpId : undefined}
      onKeyDown={(e) => { watchCaps(e); input.onKeyDown?.(e); }}
      onKeyUp={(e) => { watchCaps(e); input.onKeyUp?.(e); }}
      onBlur={(e) => { setCaps(false); input.onBlur?.(e); }} />
  );
  return (
    <div className="gate-field">
      <div className="gate-label">
        <label htmlFor={id}>{label}</label>
        {tip !== undefined && <InfoTip label={tip.label}>{tip.note}</InfoTip>}
        {aside !== undefined && <span className="gate-aside">{aside}</span>}
      </div>
      {secret ? (
        <div className="gate-secret">
          {field}
          {/* Shows what was typed, as a phone's keyboard would let you check it. */}
          <button type="button" className="gate-reveal" aria-pressed={shown} aria-controls={id}
            aria-label={shown ? `Hide ${label.toLowerCase()}` : `Show ${label.toLowerCase()}`}
            onClick={() => setShown((v) => !v)}>
            {shown ? "Hide" : "Show"}
          </button>
        </div>
      ) : field}
      {hasHelp && <span id={helpId} className={`gate-help${caps ? " bad" : tone === undefined ? "" : ` ${tone}`}`} aria-live="polite">{line}</span>}
    </div>
  );
}
