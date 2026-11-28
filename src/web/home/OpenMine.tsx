import { useId, useRef, useState, type FormEvent } from "react";
import { Icon } from "@vemi/icons";
import { addressFrom, addressProblem, forgetCopy, openLinkOf, rememberCopy, saveCopies, shownAddress, type KnownCopy } from "../myCopies.js";

/** The words on the panel, in one place. */
export const MINE_WORDS = {
  title: "Your VEMI",
  welcome: "Welcome back",
  open: "Open",
  field: "Your VEMI's address",
  placeholder: "name.workers.dev",
  go: "Open my VEMI",
  keep: "Remember it on this device",
  help: "It is the address you got at the end of setup. It ends in workers.dev, unless you gave it your own domain.",
  another: "Open a different VEMI",
  cancel: "Cancel",
  none: "New here? Get your own below, or try it first.",
} as const;

/** The first letter of a copy's name, for its round mark. */
const letterOf = (address: string): string => (shownAddress(address).replace(/^www\./, "")[0] ?? "v").toUpperCase();

/**
 * "Your VEMI" on the home page: each copy this browser has opened, one press away, and a box to
 * type an address the first time. Opening goes straight to the copy's sign-in, past its own front
 * page. Kept on this device only; the home page never asks a copy anything.
 */
export function OpenMine({ copies, onChange, saved, focusRef }: {
  readonly copies: readonly KnownCopy[];
  readonly onChange: (next: KnownCopy[]) => void;
  /** Said once, when a copy just asked to be kept. */
  readonly saved?: string | null;
  /** Given the address box, so the nav's Open can put the cursor in it. */
  readonly focusRef?: React.RefObject<HTMLInputElement | null>;
}) {
  const [adding, setAdding] = useState(copies.length === 0);
  const [typed, setTyped] = useState("");
  const [keep, setKeep] = useState(true);
  const [tried, setTried] = useState(false);
  const own = useRef<HTMLInputElement>(null);
  const box = focusRef ?? own;
  const id = useId();
  const problem = tried ? addressProblem(typed) : null;

  const open = (address: string): void => {
    const next = rememberCopy(copies, address, Date.now());
    saveCopies(next);
    onChange(next);
  };
  const submit = (e: FormEvent): void => {
    e.preventDefault();
    setTried(true);
    const address = addressFrom(typed);
    if (address === null) {
      box.current?.focus();
      return;
    }
    if (keep) open(address);
    window.location.assign(openLinkOf(address));
  };
  const forget = (address: string): void => {
    const next = forgetCopy(copies, address);
    saveCopies(next);
    onChange(next);
    if (next.length === 0) setAdding(true);
  };

  return (
    <section className="mine" aria-labelledby={`${id}-h`}>
      <h2 id={`${id}-h`} className="mine-title">{copies.length > 0 ? MINE_WORDS.welcome : MINE_WORDS.title}</h2>
      {saved !== null && saved !== undefined && <p className="mine-saved" role="status"><Icon name="lucide:check" size={16} />{saved}</p>}
      {copies.length > 0 && (
        <ul className="mine-list">
          {copies.map((copy) => (
            <li key={copy.address} className="mine-row">
              <a className="mine-open" href={openLinkOf(copy.address)} onClick={() => open(copy.address)}>
                <span className="mine-mark" aria-hidden="true">{letterOf(copy.address)}</span>
                <span className="mine-name">
                  <b>{shownAddress(copy.address)}</b>
                  <small>Sign in and carry on</small>
                </span>
                <span className="mine-go">{MINE_WORDS.open}<Icon name="lucide:arrow-right" size={18} /></span>
              </a>
              <button type="button" className="mine-forget" aria-label={`Forget ${shownAddress(copy.address)} on this device`}
                title="Forget on this device" onClick={() => forget(copy.address)}>
                <Icon name="lucide:x" size={16} />
              </button>
            </li>
          ))}
        </ul>
      )}
      {adding ? (
        <form className="mine-form" onSubmit={submit} noValidate>
          <label className="mine-label" htmlFor={`${id}-a`}>{MINE_WORDS.field}</label>
          <div className="mine-field">
            <input ref={box} id={`${id}-a`} className="mine-input" type="url" inputMode="url" enterKeyHint="go"
              autoComplete="url" autoCapitalize="off" autoCorrect="off" spellCheck={false}
              placeholder={MINE_WORDS.placeholder} value={typed} aria-invalid={problem !== null}
              aria-describedby={`${id}-help`} onChange={(e) => setTyped(e.target.value)} />
            <button type="submit" className="mine-submit">{MINE_WORDS.go}<Icon name="lucide:arrow-right" size={18} /></button>
          </div>
          <p id={`${id}-help`} className={`mine-help${problem !== null ? " bad" : ""}`} aria-live="polite">{problem ?? MINE_WORDS.help}</p>
          <label className="mine-keep">
            <input type="checkbox" checked={keep} onChange={(e) => setKeep(e.target.checked)} />
            <span>{MINE_WORDS.keep}</span>
          </label>
          {copies.length > 0 && <button type="button" className="mine-quiet" onClick={() => { setAdding(false); setTried(false); setTyped(""); }}>{MINE_WORDS.cancel}</button>}
        </form>
      ) : (
        <button type="button" className="mine-quiet" onClick={() => { setAdding(true); requestAnimationFrame(() => box.current?.focus()); }}>
          <Icon name="lucide:plus" size={16} />{MINE_WORDS.another}
        </button>
      )}
      {copies.length === 0 && <p className="mine-none">{MINE_WORDS.none}</p>}
    </section>
  );
}
