import { useEffect, useRef, useState } from "react";
import { LANDING_SHOTS, type LandingShot } from "../landingLinks.js";
import { MAX_TILT, tiltFor } from "../landingMotion.js";
import { tabTo } from "../rove.js";

/** The shots of one device, in the order their tabs are drawn. */
export const shotsFor = (device: LandingShot["device"]): readonly LandingShot[] => LANDING_SHOTS.filter((s) => s.device === device);

/**
 * A monitor and a phone drawn in CSS, side by side with the phone over the monitor's corner,
 * each showing a real screenshot. Every picture it was given is stacked in its screen and only
 * the chosen one shows, so a change is a cross-fade. The unchosen ones are hidden from a reader.
 * With a fine pointer and motion allowed, the pair leans a little toward the pointer.
 */
export function Stage({ desk, phone, deskId, phoneId, eager, panels }: {
  readonly desk: readonly LandingShot[];
  readonly phone: readonly LandingShot[];
  readonly deskId: string;
  readonly phoneId: string;
  readonly eager: boolean;
  /** The ids of the tab panels the two screens are, when tabs drive them. */
  readonly panels?: { readonly desk: { readonly id: string; readonly labelledBy: string }; readonly phone: { readonly id: string; readonly labelledBy: string } };
}) {
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = box.current;
    if (el === null || typeof window.matchMedia !== "function") return;
    const fine = window.matchMedia("(hover: hover) and (pointer: fine)");
    const calm = window.matchMedia("(prefers-reduced-motion: reduce)");
    let frame = 0;
    const move = (e: PointerEvent): void => {
      if (!fine.matches || calm.matches || frame !== 0) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        const t = tiltFor(e.clientX, e.clientY, el.getBoundingClientRect(), MAX_TILT);
        el.style.setProperty("--tilt-x", `${t.rx}deg`);
        el.style.setProperty("--tilt-y", `${t.ry}deg`);
      });
    };
    const leave = (): void => {
      el.style.setProperty("--tilt-x", "0deg");
      el.style.setProperty("--tilt-y", "0deg");
    };
    el.addEventListener("pointermove", move, { passive: true });
    el.addEventListener("pointerleave", leave);
    return () => {
      if (frame !== 0) cancelAnimationFrame(frame);
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerleave", leave);
    };
  }, []);

  const screen = (shots: readonly LandingShot[], chosen: string, w: number, h: number, panel: { readonly id: string; readonly labelledBy: string } | undefined) => (
    <div className="landing-screen" {...(panel === undefined ? {} : { id: panel.id, role: "tabpanel", "aria-labelledby": panel.labelledBy })}>
      {shots.map((s) => (
        <img key={s.src} src={s.src} alt={s.alt} width={w} height={h} className={s.id === chosen ? "on" : ""}
          aria-hidden={s.id === chosen ? undefined : true} loading={eager && s.id === chosen ? "eager" : "lazy"} decoding="async" />
      ))}
    </div>
  );

  return (
    <div className="landing-stage" ref={box}>
      <div className="landing-stage-tilt">
        <div className="landing-monitor">{screen(desk, deskId, 2560, 1600, panels?.desk)}</div>
        <div className="landing-monitor-stand" aria-hidden="true" />
        <div className="landing-phone">{screen(phone, phoneId, 780, 1688, panels?.phone)}</div>
      </div>
    </div>
  );
}

/** A row of tabs for one device: Tab lands on the chosen one, the arrows, Home and End move along it. */
function ShotTabs({ row, label, shots, chosen, onPick }: {
  readonly row: string;
  readonly label: string;
  readonly shots: readonly LandingShot[];
  readonly chosen: string;
  readonly onPick: (id: string) => void;
}) {
  const list = useRef<HTMLDivElement>(null);
  return (
    <div className="landing-tabs" role="tablist" aria-label={label} ref={list}
      onKeyDown={(e) => {
        const to = tabTo(e, shots.findIndex((s) => s.id === chosen), shots.length);
        const next = to === null ? undefined : shots[to];
        if (to === null || next === undefined) return;
        e.preventDefault();
        onPick(next.id);
        list.current?.querySelectorAll<HTMLElement>('[role="tab"]')[to]?.focus();
      }}>
      {shots.map((s) => (
        <button key={s.id} id={`${row}-tab-${s.id}`} type="button" role="tab" aria-selected={s.id === chosen}
          aria-controls={`${row}-panel`} tabIndex={s.id === chosen ? 0 : -1}
          className={`landing-tab${s.id === chosen ? " on" : ""}`} onClick={() => onPick(s.id)}>
          {s.label}
        </button>
      ))}
    </div>
  );
}

/** The "see it" section's picture: the stage and the two rows of tabs that change what it shows. */
export function Showcase() {
  const desk = shotsFor("desk");
  const phone = shotsFor("phone");
  const [deskId, setDeskId] = useState(desk[0]?.id ?? "");
  const [phoneId, setPhoneId] = useState(phone[0]?.id ?? "");
  return (
    <div className="landing-showcase">
      <Stage desk={desk} phone={phone} deskId={deskId} phoneId={phoneId} eager={false}
        panels={{ desk: { id: "show-desk-panel", labelledBy: `show-desk-tab-${deskId}` }, phone: { id: "show-phone-panel", labelledBy: `show-phone-tab-${phoneId}` } }} />
      <div className="landing-tabsets">
        <div><span className="landing-tabs-name">On a desk</span><ShotTabs row="show-desk" label="Desktop screens" shots={desk} chosen={deskId} onPick={setDeskId} /></div>
        <div><span className="landing-tabs-name">On a phone</span><ShotTabs row="show-phone" label="Phone screens" shots={phone} chosen={phoneId} onPick={setPhoneId} /></div>
      </div>
    </div>
  );
}
