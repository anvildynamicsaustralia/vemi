import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import "./infotip.css";

/**
 * A small "i" button that opens a short note beside it. Only the pages a person sees before
 * they are in the app use it (the front page, sign-in, consent and the setup helper). A click
 * or a tap opens it; Escape, another click or a click elsewhere closes it. It is a real button
 * with an accessible name, and the note is tied to it so a screen reader reads both.
 */
export function InfoTip({ label, children, tone = "auto" }: {
  readonly label: string;
  readonly children: ReactNode;
  readonly tone?: "auto" | "on-dark";
}) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const root = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!open) return;
    const away = (e: Event): void => {
      if (root.current !== null && e.target instanceof Node && !root.current.contains(e.target)) setOpen(false);
    };
    const key = (e: KeyboardEvent): void => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("pointerdown", away);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("pointerdown", away);
      document.removeEventListener("keydown", key);
    };
  }, [open]);

  return (
    <span className={`info-tip${tone === "on-dark" ? " on-dark" : ""}`} ref={root}>
      <button type="button" className="info-tip-button" aria-label={label} aria-expanded={open} aria-controls={id}
        onClick={() => setOpen((was) => !was)}>
        <span aria-hidden="true">i</span>
      </button>
      <span id={id} role="note" className="info-tip-note" hidden={!open}>{children}</span>
    </span>
  );
}
