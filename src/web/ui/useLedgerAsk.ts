import { useEffect, useRef, useState } from "react";
import { onLedgerAsk, takeLedgerAsk, type Reach } from "../ledgerReach.js";

/**
 * Take the one-shot ask for this venture or project, then bring what it asked for into view
 * once the page can show it: the ledger, or the head of a venture's About. `open` runs when
 * the ask is taken, for a page that keeps both closed (a venture's About). Under reduced
 * motion the scroll is a jump.
 */
export function useLedgerAsk(id: string, ready: boolean, open?: () => void): void {
  const [asked, setAsked] = useState<Reach | null>(null);
  const opener = useRef(open);
  opener.current = open;
  useEffect(() => {
    // Taken on arrival, and again whenever an ask comes while this page is already open
    // (navigating to the address you are on does not remount it).
    const take = () => {
      const reach = takeLedgerAsk(id);
      if (reach === null) return;
      opener.current?.();
      setAsked(reach);
    };
    take();
    return onLedgerAsk(take);
  }, [id]);
  useEffect(() => {
    if (asked === null || !ready) return;
    // Each Reach is also the id of the element it brings into view.
    const el = document.getElementById(asked);
    if (el === null) return;
    const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    el.scrollIntoView({ behavior: still ? "auto" : "smooth", block: "start" });
    setAsked(null);
  }, [asked, ready]);
}
