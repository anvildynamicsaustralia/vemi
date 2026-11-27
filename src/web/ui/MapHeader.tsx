import type { Today } from "@vemi/shared";
import { greeting, longDate } from "../greeting.js";
import { navigate, surface } from "../router.js";
import { todayCounts } from "../todayCounts.js";
import { useApp } from "./appContext.js";
import { RAIL } from "./Chrome.js";

/** Where the rail's Today goes, read from the rail so the two never part. */
const TODAY = RAIL.find((s) => s.label === "Today")?.place ?? "today";

/**
 * The top of Home: the greeting, the day in the owner's zone, and what today holds. The
 * count is a button to Today. Overdue sits beside it only when there is some. Add is on a
 * desk only: the phone's bar already has it in the middle.
 */
export function MapHeader({ today }: { readonly today: Today }) {
  const app = useApp();
  const counts = todayCounts(today);
  return (
    <header className="map-header">
      <div className="map-header-words">
        <h1 className="map-greeting">{greeting(new Date().getHours())}</h1>
        <p className="map-date">{longDate(today.on)}</p>
      </div>
      <div className="map-header-actions">
        <button type="button" className="word-button map-today" onClick={() => navigate(surface(TODAY))}>
          {counts.on} on today
        </button>
        {/* Today lists what is late first, so that is where "overdue" goes. */}
        {counts.overdue > 0 && (
          <button type="button" className="map-overdue" onClick={() => navigate(surface(TODAY))}>{counts.overdue} overdue</button>
        )}
        {!app.phone && (
          <button type="button" className="word-button map-add-task" onClick={() => app.compose()}>Add</button>
        )}
      </div>
    </header>
  );
}
