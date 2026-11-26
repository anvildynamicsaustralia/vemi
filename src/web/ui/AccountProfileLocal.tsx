import { useEffect, useState } from "react";
import { paths, read, saveTimeZone } from "../api.js";
import { browserZone, knownZones, zoneChoices, zoneShown } from "../zoneChoices.js";
import "./accountProfile.css";

/**
 * Account > Profile in a copy kept in the page: the time zone, and nothing about signing in,
 * for there is no one to sign in as. It names no person.
 */
export function AccountProfileLocal() {
  const [saved, setSaved] = useState<string | null | undefined>(undefined);
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    read<{ readonly timeZone?: string | null }>(paths.appearance)
      .then((r) => { if (live) setSaved(r.data.timeZone ?? null); })
      .catch(() => undefined);
    return () => { live = false; };
  }, []);

  const shown = zoneShown(saved ?? null, browserZone());
  const choose = (zone: string): void => {
    setProblem(null);
    saveTimeZone(zone).then(() => setSaved(zone), (e: unknown) => setProblem(e instanceof Error ? e.message : "That did not save."));
  };

  return (
    <div className="account-rows">
      <div className="account-row">
        <span className="account-row-title">Time zone</span>
        <select className="field zone-field" aria-label="Time zone" value={shown} disabled={saved === undefined}
          onChange={(e) => choose(e.target.value)}>
          {zoneChoices(knownZones(), shown).map((z) => <option key={z} value={z}>{z}</option>)}
        </select>
      </div>
      {problem !== null && <div className="error" role="alert">{problem}</div>}
    </div>
  );
}
