import { Status } from "./Switch.js";
import { useId, type ReactNode } from "react";
import "./detail.css";

/**
 * One group of related fields on a detail screen: a card with a small heading, and the actions
 * that belong to the whole group at the end of the same row. The heading is an h3, under the
 * screen's own title, and names the card as a region for a screen reader.
 */
export function Group({ title, actions, className, children }: {
  readonly title: string;
  readonly actions?: ReactNode;
  readonly className?: string;
  readonly children: ReactNode;
}) {
  const id = useId();
  return (
    <section className={`group${className === undefined ? "" : ` ${className}`}`} aria-labelledby={id}>
      <div className="group-head">
        <h3 className="group-title" id={id}>{title}</h3>
        {actions}
      </div>
      {children}
    </section>
  );
}

/**
 * One field in a group: its label on one side and its value on the other. On a phone the two
 * stack. `wide` is a value that takes the whole row, with the label above it.
 */
export function Kv({ label, wide = false, children }: {
  readonly label: ReactNode;
  readonly wide?: boolean;
  readonly children: ReactNode;
}) {
  return (
    <div className={wide ? "kv kv-wide" : "kv"}>
      <div className="kv-k kicker">{label}</div>
      <div className="kv-v">{children}</div>
    </div>
  );
}

/** A status as a dot and a word, so it never rests on colour alone. */
export function StatusWord({ on, children }: { readonly on: boolean; readonly children: string }) {
  return <Status kind={on ? "on" : "off"}>{children}</Status>;
}
