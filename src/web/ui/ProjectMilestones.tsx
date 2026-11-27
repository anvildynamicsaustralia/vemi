import type { TreeProject, TreeVenture } from "@vemi/shared";
import { api, createOnce } from "../api.js";
import { kindsOf, leftShare } from "../counts.js";
import { currentNames, useLevelWords } from "../levelNames.js";
import { useFirstRun } from "../firstRunState.js";
import { stepSuggestion } from "../firstRunSteps.js";
import { milestoneGroups, remainingWords } from "../milestoneGroups.js";
import { makeTask } from "../newTask.js";
import { tickTask } from "../tickTask.js";
import { nextPosition } from "../treeIndex.js";
import { useApp } from "./appContext.js";
import { AddLine, EditableText } from "./controls.js";
import { navigate, projectPage } from "../router.js";
import { DatePick } from "./Picker.js";
import { MoreMenu } from "./Menu.js";
import { Ring } from "./Rings.js";
import { TabRow, panelId, tabId } from "./TabRow.js";
import "./projectMilestones.css";

/** The group of tasks that belong to no milestone: selected by this key, never a record's id. */
export const NONE = "";

/**
 * A project's milestones as cards, each with a small ring of what is left, and under them the
 * tasks of the one selected: a tick, a title that renames in place, and a row to add one more
 * (VEMI-013, decision 3). Tasks with no milestone sit in their own group. A milestone's date
 * is soft, so it is neither shown nor compared here.
 */
export function ProjectMilestones({ venture, project, picked, onPick }: {
  readonly venture: TreeVenture;
  readonly project: TreeProject;
  /** The milestone chosen, `NONE` for the loose group, or null before any choice. The page holds it. */
  readonly picked: string | null;
  readonly onPick: (id: string) => void;
}) {
  const app = useApp();
  const words = useLevelWords();
  const firstRun = useFirstRun();
  const groups = milestoneGroups(project, kindsOf(venture));
  const known = picked === NONE ? groups.none.tasks.length > 0 : groups.milestones.some((g) => g.milestone.id === picked);
  const selected = picked !== null && known ? picked : groups.milestones[0]?.milestone.id ?? NONE;
  const row = `pm-${project.id}`;
  const open = groups.milestones.find((g) => g.milestone.id === selected);
  const tasks = open === undefined ? groups.none.tasks : open.tasks;
  const home = { id: venture.id, states: venture.states, projects: venture.projects, milestones: project.milestones };
  const finished = new Set(venture.states.filter((s) => s.kind === "finished").map((s) => s.id));
  // The milestones in their order, and where the open one sits, for Move earlier and later.
  const ordered = groups.milestones.map((g) => g.milestone);
  const atIndex = open === undefined ? -1 : ordered.findIndex((m) => m.id === open.milestone.id);
  /** Two milestones trade places, as one step with its undo. */
  const swap = (a: number, b: number): void => {
    const x = ordered[a];
    const y = ordered[b];
    if (x === undefined || y === undefined) return;
    const write = (px: number, py: number) => () =>
      Promise.all([api.update("milestones", x.id, { position: px }), api.update("milestones", y.id, { position: py })]);
    void app.act(write(y.position, x.position), {
      what: `moved ${x.name} ${b < a ? "earlier" : "later"}`,
      undo: write(x.position, y.position),
      redo: write(y.position, x.position),
    }).then((ok) => { if (ok === "sent") app.notify(`Moved ${x.name} ${b < a ? "earlier" : "later"}.`, { undo: true }); });
  };

  return (
    <div className="pm">
      <TabRow row={row} label={words.milestones.toLowerCase()} selected={selected} onPick={onPick}
        tabs={[
          ...groups.milestones.map((g) => ({
            id: g.milestone.id, className: "pm-card",
            content: <>
              <Ring size="card" value={g.counts.left} share={leftShare(g.counts)} label={remainingWords(g.counts)} />
              <span className="pm-name">{g.milestone.name}</span>
              <span className="pm-left">{remainingWords(g.counts)}</span>
            </>,
          })),
          ...(groups.none.tasks.length > 0 ? [{
            id: NONE, className: "pm-card",
            content: <>
              <Ring size="card" value={groups.none.counts.left} share={leftShare(groups.none.counts)} label={remainingWords(groups.none.counts)} />
              <span className="pm-name">No {words.milestone.toLowerCase()}</span>
              <span className="pm-left">{remainingWords(groups.none.counts)}</span>
            </>,
          }] : []),
        ]} />
      <AddLine placeholder={`a ${words.milestone.toLowerCase()}`} label={`+ ${words.milestone}`}
        onAdd={(name) => app.act(createOnce("milestones", { projectId: project.id, name, position: nextPosition(project.milestones) }))} />

      {open !== undefined && (
        <div className="pm-head">
          <EditableText value={open.milestone.name} placeholder={words.milestone.toLowerCase()}
            onSave={(name, was) => app.edit("milestones", open.milestone.id, { name }, { name: was }, `renamed ${open.milestone.name}`)} />
          <span className="more-note">aiming at</span>
          <DatePick value={open.milestone.aimingOn} label="aiming at" className="pm-aim"
            onSave={(aimingOn) => void app.edit("milestones", open.milestone.id, { aimingOn }, open.milestone, `${aimingOn === null ? "cleared" : "set"} the date of ${open.milestone.name}`)} />
          <MoreMenu label={`${words.milestone.toLowerCase()} ${open.milestone.name}`} items={[
            { label: "Move earlier", disabled: atIndex <= 0, run: () => swap(atIndex, atIndex - 1) },
            { label: "Move later", disabled: atIndex < 0 || atIndex >= ordered.length - 1, run: () => swap(atIndex, atIndex + 1) },
            // Archiving a milestone leaves its tasks in the project, and undo does not put them back on it.
            { label: `Archive ${words.milestone.toLowerCase()}`, tone: "remove",
              run: () => void app.archive("milestones", open.milestone.id, `${words.milestone.toLowerCase()}; its ${words.tasks.toLowerCase()} stay in the ${words.project.toLowerCase()}, and undo brings back the ${words.milestone.toLowerCase()} only`) },
          ]} />
        </div>
      )}
      <div className="pm-tasks" role="tabpanel" id={panelId(row)} aria-labelledby={tabId(row, selected)}>
        {tasks.map((t) => {
          const done = t.stateId !== null && finished.has(t.stateId);
          return (
            <div key={t.id} className={`pm-task${done ? " isdone" : ""}`}>
              <button type="button" className="pm-box" aria-label={done ? `reopen ${t.title}` : `finish ${t.title}`} aria-pressed={done}
                onClick={() => void tickTask({ act: app.act, update: api.update, archive: api.archive, notify: app.notify }, t, venture, done)}>
                <i aria-hidden="true">{done ? "✓" : ""}</i>
              </button>
              {/* The title opens the task over this page, where everything about it is, its name
                  included. Pressing it used to start renaming it, with no way to its details. */}
              <button type="button" className="pm-task-open" dir="auto"
                onClick={() => navigate(projectPage(venture.id, project.id, t.id))}>
                <span className="pm-task-title">{t.title}</span>
                <span className="pm-task-go" aria-hidden="true">›</span>
              </button>
            </div>
          );
        })}
        <AddLine placeholder={(firstRun.step === 4 ? stepSuggestion(4, currentNames()) : null) ?? `a ${words.task.toLowerCase()}`}
          label="Add" smart cue={firstRun.step === 4}
          onAdd={(title, read) => makeTask({ act: app.act, create: api.create }, title, home, {
            projectId: project.id,
            ...(open === undefined ? {} : { milestoneId: open.milestone.id }),
            dueOn: read.dueOn,
            repeat: read.repeat,
            remindAt: read.remindAt,
          })} />
      </div>
    </div>
  );
}
