import { useMemo } from "react";
import type { Link, Tree } from "@vemi/shared";
import { api, paths } from "../api.js";
import { navigate, projectPage, surface, venture as ventureRoute } from "../router.js";
import { useResource } from "../state/resources.js";
import { indexTree } from "../treeIndex.js";
import { useLevelWords } from "../levelNames.js";
import { useApp } from "./appContext.js";
import { Pending } from "./controls.js";
import { MoreMenu } from "./Menu.js";
import { TaskBody } from "./TaskDetail.js";

/**
 * A task's own page (VEMI-007): the sheet opened out into a page.
 * The same body — state, blocked by, due, today, and everything under the hairline — with
 * room, a path back to its project and its venture's board, and its own ⋯.
 */
export function TaskPage({ ventureId, taskId }: {
  readonly ventureId: string;
  readonly taskId: string;
}) {
  const app = useApp();
  const words = useLevelWords();
  const tree = useResource<Tree>(paths.tree);
  const links = useResource<Link[]>(paths.list("links", { task: taskId }));
  const index = useMemo(() => (tree.data === null ? null : indexTree(tree.data)), [tree.data]);
  if (index === null) return <Pending error={tree.error} onRetry={tree.refetch} />;
  const located = index.tasks.get(taskId);
  if (located === undefined || located.venture.id !== ventureId) return null;
  const parentId = located.project?.parentId ?? null;
  const parent = parentId === null ? undefined : located.venture.projects.find((p) => p.id === parentId);
  const picked = app.today !== null && located.task.pickedOn === app.today;
  const menu = (
    <MoreMenu label={`${words.task.toLowerCase()} ${located.task.title}`} items={[
      { label: "Open on the board", run: () => navigate(ventureRoute(ventureId, "board", taskId)) },
      {
        label: picked ? "Take off today" : "Put on today",
        disabled: app.today === null,
        run: () => void app.act(() => api.update("tasks", taskId, { pickedOn: picked ? null : app.today }), {
          what: picked ? `took ${located.task.title} off today` : `put ${located.task.title} on today`,
          undo: () => api.update("tasks", taskId, { pickedOn: located.task.pickedOn }),
          redo: () => api.update("tasks", taskId, { pickedOn: picked ? null : app.today }),
        }),
      },
      { label: `Archive ${words.task.toLowerCase()}`, tone: "remove", run: () => { void app.archive("tasks", taskId, words.task.toLowerCase()).then((ok) => { if (ok) navigate(ventureRoute(ventureId, "board")); }); } },
      ...app.phoneMenu,
    ]} />
  );

  return (
    <div className="item-page task-page">
      <nav className="crumbs" aria-label="where this is">
        <button type="button" className="back-link" onClick={() => navigate(surface("map"))}>Map</button>
        <span className="crumb-sep" aria-hidden="true">›</span>
        <button type="button" className="back-link" onClick={() => navigate(ventureRoute(ventureId, "board"))}>{located.venture.name}</button>
        {located.project !== null && parent !== undefined && (
          <>
            <span className="crumb-sep" aria-hidden="true">›</span>
            <button type="button" className="back-link" onClick={() => navigate(projectPage(ventureId, parent.id))}>{parent.name}</button>
          </>
        )}
        {located.project !== null && (
          <>
            <span className="crumb-sep" aria-hidden="true">›</span>
            <button type="button" className="back-link" onClick={() => navigate(projectPage(ventureId, located.project?.id ?? ""))}>{located.project.name}</button>
          </>
        )}
        {/* The task's own title is the heading just below, so the trail stops at where it lives. */}
        <span className="fill" />
        {menu}
      </nav>
      <div className="kicker">{words.task}</div>
      <TaskBody key={taskId} located={located} index={index} links={links}
        onClose={() => navigate(ventureRoute(ventureId, "board"))} />
    </div>
  );
}
