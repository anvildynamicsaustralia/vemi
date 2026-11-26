/**
 * Touch and hold (VEMI-008): the rules, apart from the page, so they can be tested.
 *
 * On an iPhone a press held still on a card opens what can be done to it, as Haptic Touch
 * does. VEMI's answer is the card's
 * own ⋯ menu: the same list, opened by the hand instead of by aiming at three dots. A
 * secondary click, and the menu key, open it on a desk.
 */

/** How long a still press is held before the menu opens. iOS waits about as long. */
export const HOLD_MS = 450;

/** How far the finger may drift, in pixels, and still be holding rather than dragging. */
export const HOLD_SLOP = 8;

/**
 * Whether a press should start the hold. A finger or a pen, pressing with its first button.
 * A mouse never holds: a mouse held still on a card is the start of a drag, and a mouse has
 * a second button for this.
 */
export function holds(pointerType: string, button: number): boolean {
  return (pointerType === "touch" || pointerType === "pen") && button === 0;
}

/** Whether a press has moved far enough to be something else: a drag, or a scroll. */
export function drifted(from: { readonly x: number; readonly y: number }, to: { readonly x: number; readonly y: number }): boolean {
  return Math.hypot(to.x - from.x, to.y - from.y) > HOLD_SLOP;
}
