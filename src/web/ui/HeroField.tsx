import { useEffect, useRef } from "react";

/**
 * The hero's moving background. Behind it sits a plain gradient (the CSS on `.landing-bg`), which
 * is all anyone sees when motion is reduced, when there is no WebGL, or while the shader loads.
 * The shader is fetched only when it can run, and only after the page has drawn.
 */
export function HeroField() {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const el = canvas.current;
    const area = el?.closest<HTMLElement>(".landing-hero-wrap") ?? null;
    if (el === null || area === null) return;
    try {
      if (typeof window.matchMedia !== "function" || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    } catch {
      return;
    }
    let cancelled = false;
    let stop: (() => void) | null = null;
    import("./landingShader.js").then((m) => {
      if (cancelled) return;
      try {
        stop = m.startField(el, area);
      } catch {
        stop = null;
      }
    }).catch(() => undefined);
    return () => {
      cancelled = true;
      stop?.();
    };
  }, []);
  return <div className="landing-bg" aria-hidden="true"><canvas ref={canvas} className="landing-field" /></div>;
}
