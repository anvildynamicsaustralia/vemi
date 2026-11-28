import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { haptic } from "../haptics.js";
import { fromWheel, HOURS, MINUTES, said, toWheel, type WheelTime } from "../timeWheel.js";
import "./timeWheel.css";

const ROW = 36;

/** One wheel: a column that scrolls and settles on a value, or steps by the arrow keys. */
function Wheel<T>({ items, value, show, label, onPick }: {
  readonly items: readonly T[];
  readonly value: T;
  readonly show: (v: T) => string;
  readonly label: string;
  readonly onPick: (v: T) => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const settle = useRef<number | null>(null);
  const at = Math.max(0, items.indexOf(value));
  // Placed on the value as it opens and whenever the value changes from outside the scroll.
  useEffect(() => {
    const el = box.current;
    if (el !== null && Math.round(el.scrollTop / ROW) !== at) el.scrollTo({ top: at * ROW });
  }, [at]);
  const onScroll = (): void => {
    if (settle.current !== null) window.clearTimeout(settle.current);
    settle.current = window.setTimeout(() => {
      const el = box.current;
      if (el === null) return;
      const i = Math.min(items.length - 1, Math.max(0, Math.round(el.scrollTop / ROW)));
      const next = items[i];
      if (next !== undefined && next !== value) { haptic("tap"); onPick(next); }
    }, 90);
  };
  const onKey = (e: KeyboardEvent<HTMLDivElement>): void => {
    // Up and down step, wrapping as a wheel does; Home and End go to the first and the last.
    const to = e.key === "ArrowDown" ? (at + 1) % items.length
      : e.key === "ArrowUp" ? (at - 1 + items.length) % items.length
      : e.key === "Home" ? 0
      : e.key === "End" ? items.length - 1
      : -1;
    if (to < 0) return;
    e.preventDefault();
    const next = items[to];
    if (next !== undefined) onPick(next);
  };
  return (
    <div ref={box} className="wheel" role="spinbutton" tabIndex={0} aria-label={label} aria-valuetext={show(value)}
      aria-valuenow={at} aria-valuemin={0} aria-valuemax={items.length - 1}
      onScroll={onScroll} onKeyDown={onKey}>
      <div className="wheel-pad" aria-hidden="true" />
      {items.map((v, i) => (
        <div key={i} className={`wheel-item${i === at ? " on" : ""}`} aria-hidden="true"
          onClick={() => { box.current?.scrollTo({ top: i * ROW, behavior: "smooth" }); onPick(v); }}>{show(v)}</div>
      ))}
      <div className="wheel-pad" aria-hidden="true" />
    </div>
  );
}

/**
 * A time chosen on wheels, as a phone's clock sets one: hour, minute in fives, am or pm.
 * Turning the wheels changes nothing yet; Set says the time, so a wheel passing through 3 am
 * on its way to 9 never sets a reminder for 3.
 */
export function TimeWheel({ value, onSet, onCancel }: {
  readonly value: string;
  readonly onSet: (time: string) => void;
  readonly onCancel?: () => void;
}) {
  const [t, setT] = useState<WheelTime>(() => toWheel(value));
  return (
    <div className="time-wheel" role="group" aria-label="reminder time">
      <div className="wheels">
        <div className="wheel-band" aria-hidden="true" />
        <Wheel items={HOURS} value={t.hour} show={String} label="hour" onPick={(hour) => setT({ ...t, hour })} />
        <Wheel items={MINUTES} value={t.minute} show={(m) => String(m).padStart(2, "0")} label="minute" onPick={(minute) => setT({ ...t, minute })} />
        <Wheel items={[false, true]} value={t.pm} show={(pm) => (pm ? "pm" : "am")} label="am or pm" onPick={(pm) => setT({ ...t, pm })} />
      </div>
      <div className="time-wheel-foot">
        {onCancel !== undefined && <button type="button" className="back-link" onClick={onCancel}>Cancel</button>}
        <span className="fill" />
        <button type="button" className="primary-button" onClick={() => onSet(fromWheel(t))}>Set {said(t)}</button>
      </div>
    </div>
  );
}
