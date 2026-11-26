import type { Tree } from "@vemi/shared";
import { api, paths } from "../api.js";
import { homesFor } from "../projectNest.js";
import { useResource } from "../state/resources.js";
import { indexTree } from "../treeIndex.js";
import { useLevelWords } from "../levelNames.js";
import { currentWords } from "../levelNames.js";
import type { LevelWords } from "../levelWords.js";
import { useApp, type HomeTarget } from "./appContext.js";
import { Sheet } from "./Sheet.js";
import type { MenuItem } from "./Menu.js";

interface Placeable {
  readonly id: string;
  readonly ventureId: string;
  readonly name: string;
  readonly parentId: string | null;
  readonly position: number;
  readonly createdAt: string;
}

/**
 * The ⋯ line that opens this picker. Disabled, with the reason, on a project that holds
 * projects (one level only) and on one with nowhere to go.
 */
export function moveIntoItem(
  open: (target: HomeTarget) => void,
  project: Placeable,
  siblings: readonly Placeable[],
  w: LevelWords = currentWords(),
): MenuItem {
  const projects = w.projects.toLowerCase();
  if (siblings.some((p) => p.parentId === project.id)) return { label: `Move into… (it holds ${projects})`, disabled: true };
  if (project.parentId === null && homesFor(project, siblings).length === 0) {
    return { label: `Move into… (no other ${w.project.toLowerCase()} here)`, disabled: true };
  }
  return { label: "Move into…", run: () => open({ id: project.id, ventureId: project.ventureId, label: project.name }) };
}

/** Pick the project this one goes inside, or take it out again. Undo goes back to where it was. */
export function NestPicker({ target, onClose }: { readonly target: HomeTarget; readonly onClose: () => void }) {
  const app = useApp();
  const word = useLevelWords().project.toLowerCase();
  const tree = useResource<Tree>(paths.tree);
  const index = tree.data === null ? null : indexTree(tree.data);
  const projects = index?.ventures.get(target.ventureId)?.projects ?? [];
  const project = projects.find((p) => p.id === target.id);
  const was = project?.parentId ?? null;
  const homes = project === undefined ? [] : homesFor(project, projects);

  const choose = async (parentId: string | null): Promise<void> => {
    const ok = await app.act(() => api.update("projects", target.id, { parentId }), {
      what: parentId === null ? `moved ${target.label} out` : `moved ${target.label} inside a ${word}`,
      undo: () => api.update("projects", target.id, { parentId: was }),
      redo: () => api.update("projects", target.id, { parentId }),
    });
    if (ok) onClose();
  };

  return (
    <Sheet onClose={onClose} className="icon-sheet" placement="centre" label={`move into a ${word}`}>
      <div className="sheet-head">
        <span className="label icon-for-label">Move</span>
        <span className="icon-for">{target.label}</span>
        <span className="fill" />
        <button type="button" className="close-button" aria-label="close" onClick={onClose}>×</button>
      </div>
      <div className="sheet-body">
        <div className="picker-list" role="listbox" aria-label={`${word} to go inside`}>
          {was !== null && (
            <button type="button" role="option" aria-selected={false} className="picker-item" onClick={() => void choose(null)}>
              <span className="picker-name">Not inside a {word}</span>
            </button>
          )}
          {homes.map((h, i) => (
            <button key={h.id} type="button" role="option" aria-selected={h.id === was}
              // On the home it has now, or, with none yet, on the first it could have.
              autoFocus={was === null ? i === 0 : h.id === was}
              className={`picker-item${h.id === was ? " on" : ""}`}
              onClick={() => { if (h.id !== was) void choose(h.id); else onClose(); }}>
              <span className="picker-name">{h.name}</span>
            </button>
          ))}
          {was === null && homes.length === 0 && <div className="empty icon-empty">No other {word} here to go inside.</div>}
        </div>
      </div>
    </Sheet>
  );
}
