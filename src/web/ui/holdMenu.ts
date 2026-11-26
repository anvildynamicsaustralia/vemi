import { drifted, holds, HOLD_MS } from "../hold.js";

/**
 * Touch and hold, a secondary click or the menu key on a card opens the card's
 * own ⋯ (VEMI-008).
 *
 * A card says it can be held with `data-hold`; its ⋯ says it is the one to open with
 * `data-more`. A card holds its own ⋯, never one inside a card inside it. Listening once, on
 * the document, in the capture phase, means no card had to change how it is pressed or
 * dragged: the hold runs alongside, and when it fires it puts down whatever the press had
 * started picking up.
 */

/** The event a ⋯ listens for to open itself. */
export const HOLD_EVENT = "vemi:hold";

/** How long after the finger lifts a click is still the end of the hold, not a new press. */
const SWALLOW_MS = 350;

/** Where a hold is never a hold: somewhere to type, the menu itself, and a grip, which holds to reorder. */
const NATIVE = "input, textarea, select, [contenteditable=''], [contenteditable='true'], [data-more], [role='menu'], .grip";

interface Press {
  readonly zone: HTMLElement;
  readonly target: Element;
  readonly pointerId: number;
  readonly pointerType: string;
  readonly from: { readonly x: number; readonly y: number };
  readonly timer: number;
}

function zoneAt(target: EventTarget | null): HTMLElement | null {
  if (!(target instanceof Element) || target.closest(NATIVE) !== null) return null;
  return target.closest<HTMLElement>("[data-hold]");
}

/** The card's own ⋯: the first in it that is not inside a card of its own. */
function moreOf(zone: HTMLElement): HTMLElement | null {
  for (const el of zone.querySelectorAll<HTMLElement>("[data-more]")) {
    if (el.closest("[data-hold]") === zone) return el;
  }
  return null;
}

function reducedMotion(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export function installHold(): () => void {
  let press: Press | null = null;
  // Once the menu is open under a finger that is still down, the lift that follows is not a
  // tap on whatever the menu put under it.
  let heldDown = false;
  let swallowUntil = 0;
  // When a held finger last opened a menu: Android sends its own long press after ours.
  let lastHeld = 0;

  const release = (): void => {
    if (press === null) return;
    window.clearTimeout(press.timer);
    delete press.zone.dataset.holding;
    press = null;
  };

  const fire = (zone: HTMLElement, from: Press | null): boolean => {
    const more = moreOf(zone);
    release();
    if (more === null) return false;
    // Put down whatever the press began picking up: every drag in VEMI already lets go on a
    // cancelled pointer, and a cancelled pointer lands nothing.
    if (from !== null) {
      lastHeld = Date.now();
      from.target.dispatchEvent(new PointerEvent("pointercancel", { bubbles: true, pointerId: from.pointerId, pointerType: from.pointerType }));
      heldDown = true;
    }
    if (!reducedMotion()) {
      zone.dataset.holding = "pop";
      zone.addEventListener("animationend", () => { if (zone.dataset.holding === "pop") delete zone.dataset.holding; }, { once: true });
    }
    navigator.vibrate?.(8);
    more.dispatchEvent(new CustomEvent(HOLD_EVENT));
    return true;
  };

  const down = (e: PointerEvent): void => {
    release();
    if (!holds(e.pointerType, e.button)) return;
    const zone = zoneAt(e.target);
    if (zone === null || !(e.target instanceof Element)) return;
    const timer = window.setTimeout(() => { if (press !== null) fire(press.zone, press); }, HOLD_MS);
    press = { zone, target: e.target, pointerId: e.pointerId, pointerType: e.pointerType, from: { x: e.clientX, y: e.clientY }, timer };
    // An attribute, not a class: a card whose class React rewrites mid-press keeps it.
    zone.dataset.holding = "press";
  };

  const move = (e: PointerEvent): void => {
    if (press !== null && e.pointerId === press.pointerId && drifted(press.from, { x: e.clientX, y: e.clientY })) release();
  };

  const up = (e: PointerEvent): void => {
    if (press !== null && e.pointerId === press.pointerId) release();
    if (heldDown && e.isTrusted) {
      heldDown = false;
      swallowUntil = Date.now() + SWALLOW_MS;
    }
  };

  const click = (e: MouseEvent): void => {
    if (!heldDown && Date.now() > swallowUntil) return;
    e.preventDefault();
    e.stopPropagation();
  };

  // A secondary click, the menu key, Shift+F10 — and Android's own long press, which
  // arrives here too, after the timer has already opened the menu.
  const context = (e: MouseEvent): void => {
    const zone = zoneAt(e.target);
    if (zone === null || moreOf(zone) === null) return;
    const selected = window.getSelection();
    if (selected !== null && !selected.isCollapsed && zone.contains(selected.anchorNode)) return;
    e.preventDefault();
    if (Date.now() - lastHeld < 1000) return;
    fire(zone, press);
  };

  const opts = { capture: true } as const;
  document.addEventListener("pointerdown", down, opts);
  document.addEventListener("pointermove", move, opts);
  document.addEventListener("pointerup", up, opts);
  document.addEventListener("pointercancel", up, opts);
  document.addEventListener("click", click, opts);
  document.addEventListener("contextmenu", context, opts);
  window.addEventListener("scroll", release, opts);
  return () => {
    release();
    document.removeEventListener("pointerdown", down, opts);
    document.removeEventListener("pointermove", move, opts);
    document.removeEventListener("pointerup", up, opts);
    document.removeEventListener("pointercancel", up, opts);
    document.removeEventListener("click", click, opts);
    document.removeEventListener("contextmenu", context, opts);
    window.removeEventListener("scroll", release, opts);
  };
}
