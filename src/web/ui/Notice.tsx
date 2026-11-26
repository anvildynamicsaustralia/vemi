import { useEffect, useRef, useState } from "react";
import { begin, holding, leftAt, pause, resume, stayFor, type Countdown } from "../noticeTimer.js";

export interface NoticeAction {
  readonly label: string;
  readonly run: () => void;
}

/**
 * The one notice: the line at the foot of the screen that says what just happened and, when
 * it can be taken back, carries the Undo. Nothing is destroyed from a live surface, so every
 * archive, move and edit that can be undone says so here and nowhere else.
 *
 * Drawn only. What it says is said by the `Spoken` the shell keeps beside it, because a live
 * region that arrives already holding its words is one a screen reader often never reads.
 * It leaves by itself: 8 seconds for a plain line, 12 when there is an action to reach. The
 * wait stops while the pointer is over the notice or focus is inside it, and carries on with
 * the time that was left (`noticeTimer.ts`).
 */
export function Notice({ message, action, onClose }: {
  readonly message: string;
  readonly action?: NoticeAction | undefined;
  readonly onClose: () => void;
}) {
  const [over, setOver] = useState(false);
  const [focused, setFocused] = useState(false);
  const held = holding(over, focused);
  const clock = useRef<Countdown>(begin(stayFor(action !== undefined), Date.now()));
  const timer = useRef<number | undefined>(undefined);
  const close = useRef(onClose);
  close.current = onClose;
  const heldNow = useRef(held);
  heldNow.current = held;

  const arm = () => {
    window.clearTimeout(timer.current);
    if (heldNow.current) return;
    timer.current = window.setTimeout(() => close.current(), leftAt(clock.current, Date.now()));
  };

  // A new line starts a full wait; leaving takes the timer with it.
  useEffect(() => {
    clock.current = heldNow.current
      ? pause(begin(stayFor(action !== undefined), Date.now()), Date.now())
      : begin(stayFor(action !== undefined), Date.now());
    arm();
    return () => window.clearTimeout(timer.current);
  }, [message, action]);

  // Pointer over or focus inside stops the clock; leaving starts it with what was left.
  useEffect(() => {
    const now = Date.now();
    clock.current = held ? pause(clock.current, now) : resume(clock.current, now);
    arm();
  }, [held]);

  return (
    <div
      className="notice"
      onPointerEnter={() => setOver(true)}
      onPointerLeave={() => setOver(false)}
      onFocus={() => setFocused(true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocused(false);
      }}
    >
      <span className="notice-text">{message}</span>
      {action !== undefined && (
        <button type="button" className="notice-action" onClick={() => { action.run(); onClose(); }}>{action.label}</button>
      )}
      <button type="button" className="notice-close" aria-label="dismiss" onClick={onClose}>×</button>
    </div>
  );
}
