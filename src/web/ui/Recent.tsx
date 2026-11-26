import { useEffect, useMemo, useState } from "react";
import type { Tree } from "@vemi/shared";
import { connectorChanges, type ConnectorChangeItem } from "../api.js";
import { onConnectorChanged } from "../connectorLinks.js";
import { age } from "../format.js";
import { mapLetters } from "../monogram.js";
import { recentItems } from "../recentItems.js";
import { useApp } from "./appContext.js";
import { Monogram } from "./Chrome.js";

/**
 * How many rows, and never more. This is a panel, not a log: `decisions.md` refuses activity
 * logs outright, because for one person a log is a diary of yourself, and the only thing
 * between "what was touched last" and that diary is length. So there is no "show more", no
 * paging, no filter and no time beyond `age()` — each is the first step toward the thing
 * that was refused.
 */
const MOST = 6;

/**
 * What was touched last, under the map. Six tasks at most, newest first, each with its
 * project; a click opens the task's sheet over the map.
 *
 * It sits below the field, full width, never beside it: the map scales to the measured
 * width of `.map-wrap`, and a column next to it would quietly shrink the whole map.
 *
 * When nothing has been touched — a new account — it is not drawn at all, rather than as an
 * empty box.
 */
export function Recent({ tree }: { readonly tree: Tree }) {
  const app = useApp();
  const [changes, setChanges] = useState<readonly ConnectorChangeItem[]>([]);
  // Read once when this opens, and again only when the live channel says an app wrote, not on
  // every change to the map. Offline or refused, the tag is simply not shown.
  useEffect(() => {
    let live = true;
    const read = (): void => { connectorChanges().then((c) => { if (live) setChanges(c); }, () => {}); };
    read();
    const off = onConnectorChanged(read);
    return () => { live = false; off(); };
  }, []);
  const rows = useMemo(() => recentItems(tree, MOST, changes), [tree, changes]);
  // The letters the plates above carry, from the same helper, so a pair of alike names
  // steps aside the same way here as there.
  const letters = useMemo(() => mapLetters(tree.ventures), [tree.ventures]);
  const ventures = useMemo(() => new Map(tree.ventures.map((v) => [v.id, v])), [tree.ventures]);

  if (rows.length === 0) return null;

  const now = new Date();
  return (
    <section className="recent" aria-label="recent">
      <div className="kicker recent-kicker">Recent</div>
      <div className="recent-rows">
        {rows.map((row) => {
          const v = ventures.get(row.ventureId);
          return (
            <button key={`${row.kind}:${row.id}`} type="button" className="recent-row" onClick={() => app.openTask(row.id)}>
              <Monogram letters={letters.get(row.ventureId) ?? ""} icon={v?.icon ?? null} size="chip" />
              <span className="recent-title" dir="auto">{row.title}</span>
              <span className="recent-kind">
                {row.projectName ?? v?.name ?? ""}
                {row.via === undefined ? "" : ` via ${row.via}`}
              </span>
              <span className="recent-age">{age(row.at, now)}</span>
            </button>
          );
        })}
      </div>
    </section>
  );
}
