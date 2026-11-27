import { VENTURE_VIEWS, type Tree, type TreeVenture, type VentureView } from "@vemi/shared";
import { paths } from "../api.js";
import { useLevelWords } from "../levelNames.js";
import { initials } from "../monogram.js";
import { rowMover } from "../moveRows.js";
import type { Placed } from "../order.js";
import { useResource } from "../state/resources.js";
import { useApp } from "./appContext.js";
import { EditableText } from "./controls.js";
import { Group, Kv } from "./Group.js";
import { LifecycleSection, StatesSection } from "./Lifecycle.js";
import { Sheet } from "./Sheet.js";
import "./spaceSettings.css";

/** The most letters a monogram holds; the Worker refuses more. */
const MONOGRAM_MAX = 3;

/** The views after one is switched. Null when that would leave none on: one always stays. */
export function toggleView(views: readonly VentureView[], view: VentureView): readonly VentureView[] | null {
  const next = views.includes(view) ? views.filter((v) => v !== view) : [...views, view];
  if (next.length === 0) return null;
  return VENTURE_VIEWS.filter((v) => next.includes(v));
}

/** What typed monogram text is stored as: blank is null, which means letters from the name. */
export function monogramEdit(text: string): string | null {
  const t = text.trim();
  return t === "" ? null : [...t].slice(0, MONOGRAM_MAX).join("");
}

type Move = (kind: "states" | "stages", items: readonly Placed[], what: string) => (id: string, to: number) => void;

/**
 * Everything one space keeps about itself: its name, its monogram, which views are on, its states and its
 * stages. A state or stage takes its colour from its kind, so the kind is what is changed here.
 */
export function SpaceSettingsBody({ venture, moveIn }: {
  readonly venture: TreeVenture;
  readonly moveIn: Move;
}) {
  const app = useApp();
  const w = useLevelWords();
  const views: Record<VentureView, string> = { board: "Board", projects: w.projects };
  const switchView = (view: VentureView): void => {
    const next = toggleView(venture.views, view);
    if (next === null) {
      app.notify(`A ${w.space.toLowerCase()} keeps one view on. Turn the other on first.`);
      return;
    }
    void app.edit("ventures", venture.id, { views: next }, { views: venture.views }, `changed the views of ${venture.name}`);
  };
  return (
    <div className="space-settings">
      <Group title="Identity">
        <Kv label="Name">
          <EditableText value={venture.name} placeholder="name"
            onSave={(text, was) => {
              const name = text.trim();
              if (name === "") return Promise.resolve(false);
              return app.edit("ventures", venture.id, { name }, { name: was ?? venture.name }, `renamed ${venture.name}`);
            }} />
        </Kv>
        <Kv label="Monogram">
          <EditableText value={venture.monogram} placeholder={initials(venture.name)} allowEmpty
            onSave={(text, was) => app.edit("ventures", venture.id, { monogram: monogramEdit(text) }, { monogram: was }, `changed the monogram of ${venture.name}`)} />
        </Kv>
        <Kv label="Views">
          <div className="space-views" role="group" aria-label="views that are on">
            {VENTURE_VIEWS.map((view) => (
              <button key={view} type="button" className="space-view" aria-pressed={venture.views.includes(view)}
                onClick={() => switchView(view)}>{views[view]}</button>
            ))}
          </div>
        </Kv>
      </Group>

      <StatesSection venture={venture} moveIn={moveIn} />
      <LifecycleSection venture={venture} moveIn={moveIn} />
    </div>
  );
}

/** The sheet, opened from a plate's menu and from the project breadcrumb. It reads the space live. */
export function SpaceSettings({ ventureId, onClose }: {
  readonly ventureId: string;
  readonly onClose: () => void;
}) {
  const app = useApp();
  const w = useLevelWords();
  const tree = useResource<Tree>(paths.tree);
  const venture = tree.data?.ventures.find((v) => v.id === ventureId);
  if (venture === undefined) return null;
  const moveIn = rowMover(app.act);
  return (
    <Sheet onClose={onClose} className="space-settings-sheet" label={`${w.space.toLowerCase()} settings`}>
      <div className="sheet-head">
        <h2 className="label sheet-title">{venture.name}</h2>
        <button type="button" className="close-button" aria-label="close" onClick={onClose}>×</button>
      </div>
      <div className="sheet-body">
        <SpaceSettingsBody venture={venture} moveIn={moveIn} />
      </div>
    </Sheet>
  );
}
