import { useMemo, useState } from "react";
import type { Tree } from "@vemi/shared";
import { api, createOnce, paths } from "../api.js";
import { kindsOf, projectCounts } from "../counts.js";
import { useLevelWords } from "../levelNames.js";
import type { NextStep } from "../projectNext.js";
import { askForLedger } from "../ledgerReach.js";
import { navigate, projectPage, venture as ventureRoute } from "../router.js";
import { useResource } from "../state/resources.js";
import { indexTree, nextPosition } from "../treeIndex.js";
import { nested } from "../projectNest.js";
import { rowMover } from "../moveRows.js";
import { useApp } from "./appContext.js";
import { moveIntoItem } from "./NestPicker.js";
import { ChildRows } from "./VenturePage.js";
import { AddLine, Pending } from "./controls.js";
import { Ledger } from "./Ledger.js";
import { Register } from "./Register.js";
import { MoreMenu } from "./Menu.js";
import { useMoveToSpace } from "./MoveToSpace.js";
import { ProjectBrief } from "./ProjectBrief.js";
import { ProjectColumns } from "./ProjectColumns.js";
import { ProjectHead } from "./ProjectHead.js";
import { NONE, ProjectMilestones } from "./ProjectMilestones.js";
import { ProjectNotes } from "./ProjectNotes.js";
import { ProjectLinks, ProjectSide } from "./ProjectSide.js";
import { useLedgerAsk } from "./useLedgerAsk.js";
import { RiskTag, riskItem } from "./RiskTag.js";
import { Tags } from "./TagPicker.js";
import { Tip } from "./Tip.js";

/**
 * A project's own page, inside its venture (VEMI-013, mock 3): the head, then two columns of
 * Brief, milestones and notes beside the Next step and links, which stack on a phone. The page
 * holds the selected milestone so the milestones and the Next step agree. Tags, the projects
 * inside, the Register and the Ledger sit below.
 */
export function ProjectPage({ ventureId, projectId }: {
  readonly ventureId: string;
  readonly projectId: string;
}) {
  const app = useApp();
  const mover = useMoveToSpace();
  const tree = useResource<Tree>(paths.tree);
  /** The milestone the person last chose; null until they choose, when the first is open. */
  const [picked, setPicked] = useState<string | null>(null);
  const words = useLevelWords();
  const index = useMemo(() => (tree.data === null ? null : indexTree(tree.data)), [tree.data]);
  useLedgerAsk(projectId, tree.data !== null);
  if (index === null) return <Pending error={tree.error} onRetry={tree.refetch} />;
  const venture = index.ventures.get(ventureId);
  const project = venture?.projects.find((p) => p.id === projectId);
  if (venture === undefined || project === undefined) return null;

  const kinds = kindsOf(venture);
  const counts = projectCounts(project, kinds);
  const inside = nested(venture.projects).find((n) => n.project.id === project.id)?.children ?? [];
  /** Children reorder among themselves, as on the venture's list. */
  const moveChildren = rowMover(app.act);
  const menu = (
    <MoreMenu label={`${words.project.toLowerCase()} ${project.name}`} items={[
      { label: `Add a ${words.task.toLowerCase()} to this ${words.project.toLowerCase()}`, run: () => app.compose({ ventureId, projectId }) },
      { label: "Decisions and risks", run: () => { askForLedger(project.id); navigate(projectPage(ventureId, project.id)); } },
      {
        label: project.pinnedAt === null ? `Pin ${words.project.toLowerCase()}` : `Unpin ${words.project.toLowerCase()}`,
        run: () => {
          const was = project.pinnedAt;
          void app.edit("projects", project.id, { pinnedAt: was === null ? new Date().toISOString() : null }, { pinnedAt: was },
            was === null ? `pinned ${project.name}` : `unpinned ${project.name}`);
        },
      },
      riskItem(app, "projects", project),
      moveIntoItem(app.pickHome, project, venture.projects),
      mover.item({ id: project.id, name: project.name, ventureId }),
      { label: "Choose an icon", run: () => app.pickIcon({ kind: "projects", id: project.id, label: project.name, current: project.icon }) },
      { label: `Archive ${words.project.toLowerCase()}`, tone: "remove", run: () => { void app.archive("projects", project.id, words.project.toLowerCase()).then((ok) => { if (ok) navigate(ventureRoute(ventureId, "projects")); }); } },
      ...app.phoneMenu,
    ]} />
  );
  const total = counts.left + counts.done;
  /** The milestone the Next step prefers: the one open on screen, or none for the loose group. */
  const openMilestone = picked === null ? project.milestones[0]?.id ?? null : picked === NONE ? null : picked;
  /** Takes the person to the place a Next step that is not a task names. */
  const goTo = (step: NextStep): void => {
    const root = document.querySelector<HTMLElement>(".pjmain");
    if (root === null) return;
    const target = step.kind === "brief"
      ? root.querySelector<HTMLElement>(".bstep.cue .editable, .bstep .editable")
      : step.kind === "milestone"
        ? root.querySelector<HTMLElement>(".pm .add-line input")
        : root.querySelector(".pm-tasks")?.querySelector<HTMLElement>(".add-line input") ?? null;
    target?.scrollIntoView({ block: "center" });
    target?.focus();
    if (step.kind === "brief") target?.click();
  };

  return (
    <div className="item-page pj-page">
      {mover.sheet}
      <ProjectHead venture={venture} project={project} />
      <Tip name="project" />
      <div className="pj-bar">
        <p className="item-said">
          <RiskTag blocked={project.blocked} atRisk={project.atRisk} />
          {project.blocked && ` Something in this ${words.project.toLowerCase()} is waiting on something else.`}
        </p>
        {menu}
      </div>

      <ProjectColumns
        main={(
          <>
            <ProjectBrief project={project} />
            <section aria-label={words.milestones}>
              <h3 className="pj-h">{words.milestones} <em>{counts.done} of {total} {words.tasks.toLowerCase()} done</em></h3>
              <ProjectMilestones venture={venture} project={project} picked={picked} onPick={setPicked} />
            </section>
            <section aria-label="Notes">
              <h3 className="pj-h">Notes</h3>
              <ProjectNotes projectId={projectId} />
            </section>
            <ProjectLinks projectId={projectId} className="links-phone" />
          </>
        )}
        side={<ProjectSide venture={venture} project={project} selectedMilestoneId={openMilestone} onGo={goTo} />}
      />

      <div className="pj-below">
        <Register projectId={projectId} />
        <section className="about-block">
          <Tags tagIds={project.tagIds} of="project"
            onChange={(tagIds, was) => app.act(() => api.update("projects", project.id, { tagIds }), {
              what: `changed the tags on ${project.name}`,
              // The way back is the list this choice replaced, not `project.tagIds` — that
              // is what the Worker last sent, which is a choice behind while a write is out.
              undo: () => api.update("projects", project.id, { tagIds: was }),
              redo: () => api.update("projects", project.id, { tagIds }),
            })} />
        </section>
        {project.parentId === null && (
          <section className="about-block">
            <div className="kicker more-kicker">{words.projects} inside</div>
            {inside.length === 0 && <div className="more-empty">No {words.projects.toLowerCase()} inside {project.name}.</div>}
            <ChildRows ventureId={ventureId} parent={project} inside={inside} projects={venture.projects} kinds={kinds} move={moveChildren} />
            <AddLine placeholder={`a ${words.project.toLowerCase()} inside ${project.name}`} label={`Add ${words.project.toLowerCase()}`}
              onAdd={(name) => app.act(createOnce("projects", { ventureId, name, parentId: project.id, position: nextPosition(venture.projects) }))} />
          </section>
        )}
        <Ledger projectId={projectId} />
      </div>
    </div>
  );
}
