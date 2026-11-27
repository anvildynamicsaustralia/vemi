import { useState, type ReactNode } from "react";
import type { Tree } from "@vemi/shared";
import { api, paths } from "../api.js";
import { useLevelWords } from "../levelNames.js";
import { navigate, projectPage } from "../router.js";
import { useResource } from "../state/resources.js";
import { useApp } from "./appContext.js";
import type { MenuItem } from "./Menu.js";
import { Sheet } from "./Sheet.js";

interface Moving { readonly id: string; readonly name: string; readonly ventureId: string }

/**
 * "Move to another space…" for a project's ⋯, and the sheet it opens: every other space, one
 * press each. Its tasks go with it (the Worker moves them), as one step with its undo, and the
 * page follows the project if it was open.
 */
export function useMoveToSpace(): { readonly item: (p: Moving) => MenuItem; readonly sheet: ReactNode } {
  const app = useApp();
  const w = useLevelWords();
  const tree = useResource<Tree>(paths.tree);
  const [moving, setMoving] = useState<Moving | null>(null);
  const others = (tree.data?.ventures ?? []).filter((v) => moving !== null && v.id !== moving.ventureId);

  const move = (to: { readonly id: string; readonly name: string }): void => {
    if (moving === null) return;
    const p = moving;
    setMoving(null);
    const there = (ventureId: string) => () => api.update("projects", p.id, { ventureId, parentId: null });
    void app.act(there(to.id), {
      what: `moved ${p.name} to ${to.name}`,
      undo: there(p.ventureId),
      redo: there(to.id),
    }).then((ok) => {
      if (!ok) return;
      if (ok === "sent") app.notify(`Moved ${p.name} to ${to.name}, with its ${w.tasks.toLowerCase()}.`, { undo: true });
      if (window.location.pathname.includes(p.id)) navigate(projectPage(to.id, p.id), { replace: true });
    });
  };

  const space = w.space.toLowerCase();
  const item = (p: Moving): MenuItem => (tree.data !== null && tree.data.ventures.length < 2
    ? { label: `Move to another ${space} (there is no other)`, disabled: true }
    : { label: `Move to another ${space}…`, run: () => setMoving(p) });

  const sheet = moving === null ? null : (
    <Sheet onClose={() => setMoving(null)} placement="centre" className="move-space-sheet" label={`move ${moving.name}`}>
      <div className="sheet-head">
        <span className="label">Move “{moving.name}” to</span>
        <span className="fill" />
        <button type="button" className="close-button" aria-label="close" onClick={() => setMoving(null)}>×</button>
      </div>
      <div className="sheet-body move-space-list" role="list">
        {others.map((v) => (
          <button key={v.id} type="button" role="listitem" className="move-space-row" onClick={() => move(v)}>
            <span>{v.name}</span><span aria-hidden="true">›</span>
          </button>
        ))}
        <p className="move-space-note">Its {w.tasks.toLowerCase()} go with it.</p>
      </div>
    </Sheet>
  );
  return { item, sheet };
}
