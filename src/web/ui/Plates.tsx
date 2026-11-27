import { useState } from "react";
import { hiddenProjects, PLATE_ROWS, type Flag, type Plate, type PlateProject } from "../plates.js";
import { leftShare } from "../counts.js";
import type { LevelWords } from "../levelWords.js";
import { navigate, projectPage, venture } from "../router.js";
import { useApp } from "./appContext.js";
import type { Tree } from "@vemi/shared";
import { createOnce, paths } from "../api.js";
import { resourceAt } from "../state/resources.js";
import { nextPosition } from "../treeIndex.js";
import { AddLine } from "./controls.js";
import { Monogram } from "./Chrome.js";
import { MoreMenu } from "./Menu.js";
import { Ring } from "./Rings.js";
import { Sheet } from "./Sheet.js";
import { SpaceSettings } from "./SpaceSettings.js";
import { RenameSheet } from "./RenameSheet.js";
import type { Outcome } from "../outcome.js";

const FLAG_WORDS: Record<Flag, string> = { blocked: "Blocked", overdue: "Overdue", "at risk": "At risk" };

/** A flag is a state, so it is the one chip that takes the accent. */
const FlagChip = ({ flag }: { readonly flag: Flag }) => (
  <span className={`plate-chip flag${flag === "at risk" ? " risk" : ""}`}>{FLAG_WORDS[flag]}</span>
);

function ProjectRow({ project, words }: { readonly project: PlateProject; readonly words: LevelWords }) {
  const tasks = words.tasks.toLowerCase();
  return (
    <button type="button" className="plate-project" onClick={() => navigate(projectPage(project.ventureId, project.id))}>
      <span className="plate-project-name">
        {project.name}
        {project.onToday && <i className="plate-today-dot" role="img" aria-label="on today" title="On today" />}
      </span>
      <span className="plate-project-state">
        {project.flag !== null ? <FlagChip flag={project.flag} /> : project.stage}
      </span>
      <Ring size="card" value={project.left} share={leftShare(project)} label={`${project.left} ${tasks} left`} />
    </button>
  );
}

function SpaceMenu({ plate, words }: { readonly plate: Plate; readonly words: LevelWords }) {
  const app = useApp();
  const [open, setOpen] = useState<"settings" | "rename" | "project" | null>(null);
  const space = words.space.toLowerCase();
  const project = words.project.toLowerCase();
  return (
    <>
    <MoreMenu label={`${space} ${plate.name}`} className="card-more" items={[
      { label: "Open", run: () => navigate(venture(plate.id)) },
      { label: "Rename", run: () => setOpen("rename") },
      { label: `Add a ${words.task.toLowerCase()} here`, run: () => app.compose({ ventureId: plate.id }) },
      { label: `Add a ${project} here`, run: () => setOpen("project") },
      { label: "Settings", run: () => setOpen("settings") },
      { label: `Archive ${space}`, tone: "remove", run: () => void app.archive("ventures", plate.id, space) },
    ]} />
    {open === "settings" && <SpaceSettings ventureId={plate.id} onClose={() => setOpen(null)} />}
    {open === "rename" && (
      <RenameSheet what={space} name={plate.name} onClose={() => setOpen(null)}
        onRename={(name) => app.edit("ventures", plate.id, { name }, { name: plate.name }, `renamed ${plate.name}`)} />
    )}
    {open === "project" && (
      <Sheet onClose={() => setOpen(null)} className="new-space-sheet" placement="centre" label={`new ${project} in ${plate.name}`}>
        <div className="sheet-head">
          <span className="label">New {project} in {plate.name}</span>
          <span className="fill" />
          <button type="button" className="close-button" aria-label="close" onClick={() => setOpen(null)}>×</button>
        </div>
        <div className="sheet-body">
          <AddLine placeholder={`name this ${project}`} label={`Add ${project}`} onEscape={() => setOpen(null)}
            onAdd={async (name) => {
              const ok = await app.act(createOnce("projects", { ventureId: plate.id, name, position: nextPosition(resourceAt<Tree>(paths.tree).data?.ventures.find((v) => v.id === plate.id)?.projects ?? []) }));
              if (ok) setOpen(null);
              return ok;
            }} />
        </div>
      </Sheet>
    )}
    </>
  );
}

/**
 * One plate. Pressing the header opens the space, the way every other card in VEMI opens what
 * it shows. Closed, the plate lists three projects and "N more"; "N more" shows the rest and
 * "Show fewer" folds them back. A space nested in it is drawn inside, with its own header.
 */
function PlateCard({ plate, words, open, toggle, inner = false }: {
  readonly plate: Plate;
  readonly words: LevelWords;
  readonly open: ReadonlySet<string>;
  readonly toggle: (id: string) => void;
  readonly inner?: boolean;
}) {
  const isOpen = open.has(plate.id);
  const hidden = hiddenProjects(plate.projects);
  const shown = isOpen ? plate.projects : plate.projects.slice(0, PLATE_ROWS);
  const tasks = words.tasks.toLowerCase();
  return (
    <article className={`plate-card${inner ? " inner" : ""}${isOpen ? " open" : ""}`}>
      <div className="plate-card-head">
        <button type="button" className="plate-card-toggle" aria-label={`Open ${words.space.toLowerCase()} ${plate.name}`} onClick={() => navigate(venture(plate.id))}>
          <Monogram letters={plate.letters} icon={plate.icon} />
          <span className="plate-card-name">
            <b>{plate.name}</b>
            <span className="plate-chips">
              {plate.stage !== null && <span className="plate-chip">{plate.stage}</span>}
              {plate.flags.map((f) => <FlagChip key={f} flag={f} />)}
            </span>
          </span>
          <Ring size={inner ? "owned" : "plate"} value={plate.counts.left} share={leftShare(plate.counts)} label={`${plate.counts.left} ${tasks} left`} />
        </button>
        <SpaceMenu plate={plate} words={words} />
      </div>
      {shown.length > 0 && (
        <div className="plate-projects">
          {shown.map((p) => <ProjectRow key={p.id} project={p} words={words} />)}
          {hidden > 0 && (
            <button type="button" className="plate-more" aria-expanded={isOpen} onClick={() => toggle(plate.id)}>
              {isOpen ? "Show fewer" : `${hidden} more`}
            </button>
          )}
        </div>
      )}
      {plate.inner.map((child) => (
        <PlateCard key={child.id} plate={child} words={words} open={open} toggle={toggle} inner />
      ))}
    </article>
  );
}

/** The sheet a New plate opens: a name, and nothing else. */
export function NewSpaceSheet({ words, onAdd, onClose }: {
  readonly words: LevelWords;
  readonly onAdd: (name: string) => Promise<Outcome>;
  readonly onClose: () => void;
}) {
  const word = words.space.toLowerCase();
  return (
    <Sheet onClose={onClose} className="new-space-sheet" placement="centre" label={`new ${word}`}>
      <div className="sheet-head">
        <span className="label">New {word}</span>
        <button type="button" className="close-button" aria-label="close" onClick={onClose}>×</button>
      </div>
      <div className="sheet-body">
        <AddLine placeholder={`name this ${word}`} label={`Add ${word}`} onAdd={onAdd} onEscape={onClose} />
      </div>
    </Sheet>
  );
}

/** Every top-level space as a plate, three across on a desk and one on a phone, then New. */
export function Plates({ plates, words, onNew }: {
  readonly plates: readonly Plate[];
  readonly words: LevelWords;
  readonly onNew: () => void;
}) {
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const toggle = (id: string): void => setOpen((now) => {
    const next = new Set(now);
    if (!next.delete(id)) next.add(id);
    return next;
  });
  return (
    <div className="plate-grid">
      {plates.map((p) => <PlateCard key={p.id} plate={p} words={words} open={open} toggle={toggle} />)}
      <button type="button" className="plate-new" onClick={onNew}>
        <span aria-hidden="true">+</span>
        <span>New {words.space.toLowerCase()}</span>
      </button>
    </div>
  );
}
