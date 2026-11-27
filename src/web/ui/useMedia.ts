import { useSyncExternalStore } from "react";

/**
 * A phone: narrow, or a touch screen held sideways. A phone on its side is 844-932px wide,
 * a desk's width, but it is still a thumb on a screen 390px tall, and the desk's rail and
 * targets are not drawn for that. A tablet on its side is taller than this and stays a desk.
 *
 * Every phone block in `app.css` is written with exactly this query, and
 * `tests/phone-query.test.ts` holds them to it.
 */
export const PHONE = "(max-width: 719px), (pointer: coarse) and (max-height: 500px)";

export function useMedia(query: string): boolean {
  return useSyncExternalStore(
    (changed) => {
      const list = window.matchMedia(query);
      list.addEventListener("change", changed);
      return () => list.removeEventListener("change", changed);
    },
    () => window.matchMedia(query).matches,
    // Drawn away from a browser (a static render, a test) there is no screen: not a phone.
    () => false,
  );
}
