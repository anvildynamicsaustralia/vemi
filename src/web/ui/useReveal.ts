import { useEffect, type RefObject } from "react";

/**
 * Sections ease in as they scroll into view. Nothing is hidden until this has run: it marks the
 * page as armed only when the browser can observe scrolling and the person has not asked for
 * less motion, so with no script, old browsers or reduced motion every section is simply there.
 */
export function useReveal(root: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const page = root.current;
    if (page === null || typeof IntersectionObserver === "undefined" || typeof window.matchMedia !== "function") return;
    try {
      if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    } catch {
      return;
    }
    const targets = [...page.querySelectorAll<HTMLElement>(".landing-reveal")];
    const watch = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        entry.target.classList.add("in");
        watch.unobserve(entry.target);
      }
    }, { rootMargin: "0px 0px -8% 0px", threshold: 0.05 });
    for (const t of targets) watch.observe(t);
    page.classList.add("landing-armed");
    return () => {
      watch.disconnect();
      page.classList.remove("landing-armed");
      for (const t of targets) t.classList.remove("in");
    };
  }, [root]);
}
