import { api } from "../api.js";
import { riskMark } from "../riskMark.js";
import type { AppActions } from "./appContext.js";
import type { MenuItem } from "./Menu.js";

/** The Blocked or At risk tag for a venture or project, or nothing. */
export function RiskTag({ blocked, atRisk }: { readonly blocked: boolean; readonly atRisk: boolean }) {
  const mark = riskMark(blocked, atRisk);
  if (mark === "blocked") return <span className="tag-blocked">Blocked</span>;
  if (mark === "at-risk") return <span className="tag-at-risk">At risk</span>;
  return null;
}

/**
 * The ⋯ item that sets or clears at risk on a venture or project, with undo and redo. It
 * says what it will do next: "Mark at risk" when clear, "No longer at risk" when set.
 */
export function riskItem(
  app: AppActions,
  kind: "ventures" | "projects",
  record: { readonly id: string; readonly name: string; readonly atRisk: boolean },
): MenuItem {
  const next = !record.atRisk;
  return {
    label: next ? "Mark at risk" : "No longer at risk",
    run: () => void app.act(() => api.update(kind, record.id, { atRisk: next }), {
      what: next ? `marked ${record.name} at risk` : `cleared at risk on ${record.name}`,
      undo: () => api.update(kind, record.id, { atRisk: !next }),
      redo: () => api.update(kind, record.id, { atRisk: next }),
    }),
  };
}
