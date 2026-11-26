import type { ReactNode } from "react";
import "./lockable.css";

/** The small padlock, drawn the same everywhere a field is locked. Decorative: its words sit beside it. */
export function LockIcon({ size = 16 }: { readonly size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="5" y="11" width="14" height="9" rx="2" />
      <path d="M8 11V8a4 4 0 0 1 8 0v3" />
    </svg>
  );
}

/**
 * What a locked field shows on a device that does not hold the key: a lock, "Locked" and Open.
 * `children` is what Open brought up in place (the way in), which then stands where the button was.
 * A field that cannot be read at all says so and offers no Open. Pure.
 */
export function LockedBlock({ onOpen, damaged = false, children }: {
  readonly onOpen: () => void;
  readonly damaged?: boolean;
  readonly children?: ReactNode;
}) {
  return (
    <div className="locked-block">
      <LockIcon />
      <span className="locked-word">{damaged ? "Can't be read" : "Locked"}</span>
      {!damaged && children === undefined && <button type="button" className="row-action" onClick={onOpen}>Open</button>}
      {children !== undefined && <div className="lockable-panel">{children}</div>}
    </div>
  );
}
