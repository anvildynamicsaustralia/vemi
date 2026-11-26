/**
 * The one on/off control: a real switch. A button with `role="switch"` and `aria-checked`,
 * a track and knob that move, and the word On or Off beside them, so the state is shape and
 * word and never colour alone. Its name is `label`, which is the row's title, so a screen
 * reader says "Front page, switch, on". The target is 44px high on touch (`controls.css`).
 *
 * `on` is null while the state is still being read: the switch is drawn and cannot be used.
 */
export function Switch({ on, label, onChange, disabled = false }: {
  readonly on: boolean | null;
  readonly label: string;
  readonly onChange: (next: boolean) => void;
  readonly disabled?: boolean;
}) {
  return (
    <button type="button" role="switch" className={`switch${on === true ? " on" : ""}`} aria-checked={on === true} aria-label={label}
      disabled={disabled || on === null} onClick={() => { if (on !== null) onChange(!on); }}>
      <span className="switch-track" aria-hidden="true"><span className="switch-knob" /></span>
      <span className="switch-word" aria-hidden="true">{on === null ? "" : on ? "On" : "Off"}</span>
    </button>
  );
}

/** What a thing is doing, as a dot and its word, so the colour is never the whole news. */
export type StatusKind = "on" | "off" | "working" | "stopped" | "waiting" | "done";

export function Status({ kind, children }: { readonly kind: StatusKind; readonly children: string }) {
  return (
    <span className="status-word" data-status={kind}>
      <span className={`led led-${kind}`} aria-hidden="true" />
      {children}
    </span>
  );
}
