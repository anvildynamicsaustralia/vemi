import { useEffect, useRef, useState } from "react";
import { Landing } from "../ui/Landing.js";
import { loadCopies, mineFrom, openLinkOf, rememberCopy, saveCopies, shownAddress, type KnownCopy } from "../myCopies.js";
import { OpenMine } from "./OpenMine.js";

/**
 * The VEMI home page, at the front's `/`: the front page everyone sees, with "Your VEMI" at the
 * top so someone who already has a copy is one press from it. A copy's own "Add to the home page"
 * link arrives here with `?mine=`, which is kept and taken out of the address.
 */
export function FrontHome() {
  const [copies, setCopies] = useState<KnownCopy[]>(() => loadCopies());
  const [saved, setSaved] = useState<string | null>(null);
  const box = useRef<HTMLInputElement>(null);
  const panel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const mine = mineFrom(window.location.search);
    if (mine === null) return;
    const next = rememberCopy(loadCopies(), mine, Date.now());
    saveCopies(next);
    setCopies(next);
    setSaved(`Saved. ${shownAddress(mine)} opens from here now.`);
    const url = new URL(window.location.href);
    url.searchParams.delete("mine");
    window.history.replaceState(null, "", url.pathname + url.search + url.hash);
  }, []);

  /** The nav's Open: straight to the one copy this browser knows, or to the box to type one. */
  const openMine = (): void => {
    const only = copies.length === 1 ? copies[0] : undefined;
    if (only !== undefined) {
      saveCopies(rememberCopy(copies, only.address, Date.now()));
      window.location.assign(openLinkOf(only.address));
      return;
    }
    panel.current?.scrollIntoView({ block: "center" });
    const first = panel.current?.querySelector<HTMLElement>(".mine-open, .mine-input");
    first?.focus({ preventScroll: true });
  };

  return (
    <Landing
      onSignIn={openMine}
      signInLabel="Open my VEMI"
      haveLabel="Open my VEMI"
      mine={<div ref={panel}><OpenMine copies={copies} onChange={setCopies} saved={saved} focusRef={box} /></div>}
    />
  );
}
