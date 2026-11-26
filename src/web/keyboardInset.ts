/**
 * How much of the bottom of the screen the on-screen keyboard covers, for the sheets and
 * pickers a phone draws along the bottom edge.
 *
 * Neither phone browser moves the page for the keyboard: iOS never has, and Chrome on Android
 * stopped in 108. A sheet pinned to `bottom: 0` stays pinned to the bottom of the page, under
 * the keyboard, with the results under a find field and the delete sheet's buttons beneath
 * it. The visual viewport is the part still showing; what lies below it is covered. The
 * stylesheet reads the answer as `--kb`.
 */

/**
 * The layout viewport below the visual one, in whole pixels. Nothing while the page is
 * pinch-zoomed: the visual viewport is smaller then because it is magnified, not because
 * anything covers it, and a sheet that rose for a zoom would chase the fingers.
 */
export function coveredBelow(layoutHeight: number, visual: { readonly height: number; readonly offsetTop: number; readonly scale: number }): number {
  if (Math.abs(visual.scale - 1) > 0.01) return 0;
  return Math.max(0, Math.round(layoutHeight - visual.height - visual.offsetTop));
}

/** Keeps `--kb` on the root up to date, once a frame at most. */
export function trackKeyboard(): void {
  const visual = window.visualViewport;
  if (visual === null) return;
  let frame = 0;
  const measure = (): void => {
    frame = 0;
    document.documentElement.style.setProperty("--kb", `${coveredBelow(window.innerHeight, visual)}px`);
  };
  const soon = (): void => {
    if (frame === 0) frame = window.requestAnimationFrame(measure);
  };
  visual.addEventListener("resize", soon);
  visual.addEventListener("scroll", soon);
  measure();
}
