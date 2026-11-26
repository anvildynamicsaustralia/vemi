import { useLayoutEffect, useSyncExternalStore } from "react";
import { useExtras } from "../extras.js";
import { markTipSeen, useFirstRun } from "../firstRunState.js";
import { useLevelWords } from "../levelNames.js";
import { tipFor, type TipName } from "../tips.js";
import { PHONE, useMedia } from "./useMedia.js";
import "./tip.css";

/** The tips on screen, oldest first. The newest is the one drawn, so a sheet's tip beats the map's. */
let open: readonly TipName[] = [];
const listeners = new Set<() => void>();
const change = (next: readonly TipName[]): void => { open = next; for (const l of listeners) l(); };

/** The tip for a screen, a quiet line that goes when tapped. Draws nothing when none is due. */
export function Tip({ name }: { readonly name: TipName }) {
  const state = useFirstRun();
  const words = useLevelWords();
  const extras = useExtras();
  const phone = useMedia(PHONE);
  const stack = useSyncExternalStore((l) => { listeners.add(l); return () => { listeners.delete(l); }; }, () => open, () => open);
  const line = tipFor(name, { words, phone, smartDates: extras.smartDates, state });
  const due = line !== null;

  useLayoutEffect(() => {
    if (!due) return undefined;
    change([...open, name]);
    return () => change(open.filter((n) => n !== name));
  }, [due, name]);

  const top = stack[stack.length - 1];
  if (line === null || (top !== undefined && top !== name && stack.includes(name))) return null;
  return <button type="button" className="tip" onClick={() => markTipSeen(name)}>{line}</button>;
}
