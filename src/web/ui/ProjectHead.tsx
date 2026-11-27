import { useState } from "react";
import type { TreeProject, TreeVenture } from "@vemi/shared";
import { kindsOf, leftShare, projectCounts } from "../counts.js";
import { initials } from "../monogram.js";
import { pinEdit, stageEdit } from "../projectHeadEdits.js";
import { navigate, projectPage, surface, venture as ventureRoute } from "../router.js";
import { byPosition } from "../treeIndex.js";
import { useApp } from "./appContext.js";
import { useLevelWords } from "../levelNames.js";
import { EditableText } from "./controls.js";
import { Group } from "./Group.js";
import { Ring } from "./Rings.js";
import { SpaceSettings } from "./SpaceSettings.js";
import { markTipSeen } from "../firstRunState.js";
import "./projectHead.css";

/**
 * The top of a project's page (VEMI-013, project phase): where it sits, its monogram, its name
 * edited in place, how much is left, a pin, and its stage. The middle step of the breadcrumb is
 * the space's own name. Every change goes through `app.edit`, so the undo notice shows.
 */
export function ProjectHead({ venture, project }: {
  readonly venture: TreeVenture;
  readonly project: TreeProject;
}) {
  const app = useApp();
  const w = useLevelWords();
  const [settings, setSettings] = useState(false);
  const counts = projectCounts(project, kindsOf(venture));
  const parent = project.parentId === null ? undefined : venture.projects.find((p) => p.id === project.parentId);
  const stages = [...venture.stages].sort(byPosition);
  const pinned = project.pinnedAt !== null;
  const setStage = (next: string | null): void => {
    const change = stageEdit(project, next);
    if (change !== null) void app.edit("projects", project.id, change.fields, change.current, change.what);
  };
  const pin = (): void => {
    const change = pinEdit(project, new Date().toISOString());
    markTipSeen("map");
    void app.edit("projects", project.id, change.fields, change.current, change.what);
  };

  return (
    <div className="phead-wrap">
      <nav className="crumbs pcrumb" aria-label="where this is">
        <button type="button" className="back-link" onClick={() => navigate(surface("map"))}>Map</button>
        <span className="crumb-sep" aria-hidden="true">›</span>
        <button type="button" className="back-link" onClick={() => navigate(ventureRoute(venture.id, "projects"))}>{venture.name}</button>
        {parent !== undefined && (
          <>
            <span className="crumb-sep" aria-hidden="true">›</span>
            <button type="button" className="back-link" onClick={() => navigate(projectPage(venture.id, parent.id))}>{parent.name}</button>
          </>
        )}
        {/* The project's name is the heading just below, so the trail stops at where it lives. */}
        <span className="fill" />
        <button type="button" className="back-link crumb-settings" onClick={() => setSettings(true)}>{w.space} settings</button>
      </nav>
      {settings && <SpaceSettings ventureId={venture.id} onClose={() => setSettings(false)} />}
      <div className="phead">
        <span className="phead-mono" aria-hidden="true">{initials(project.name)}</span>
        <h2 className="phead-title" dir="auto">
          <EditableText value={project.name} placeholder="name"
            onSave={(name, was) => app.edit("projects", project.id, { name }, { name: was }, `renamed ${project.name}`)} />
        </h2>
        <span className="phead-end">
          <Ring size="plate" value={counts.left} share={leftShare(counts)} label={`${counts.left} left`} />
          <button type="button" className="phead-pin" aria-pressed={pinned} aria-label="Pin to the top of the map" onClick={pin}>
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" strokeLinecap="round" aria-hidden="true">
              <path d="M9 3.5h6l-1 6 3.5 3.5h-11L10 9.5l-1-6zM12 13v7.5" />
            </svg>
          </button>
        </span>
      </div>
      <Group title="Stage" className="phead-group">
        <div className="phead-stages" role="group" aria-label="Stage">
          <button type="button" className="phead-stage" aria-pressed={project.stageId === null} onClick={() => setStage(null)}>No stage</button>
          {stages.map((s) => (
            <button key={s.id} type="button" className="phead-stage" aria-pressed={project.stageId === s.id} onClick={() => setStage(s.id)}>{s.name}</button>
          ))}
        </div>
      </Group>
    </div>
  );
}
