import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Icon } from "@vemi/icons";
import type { Note, Overview, Tree, TreeProject } from "@vemi/shared";
import { api, createOnce, paths } from "../api.js";
import type { Outcome } from "../outcome.js";
import { kindsOf, projectCounts } from "../counts.js";
import { shortDate } from "../format.js";
import { rowMover } from "../moveRows.js";
import type { Placed } from "../order.js";
import { addedTo, makeTask, makeTasks } from "../newTask.js";
import { tasksSender } from "../tasksSender.js";
import { askForLedger } from "../ledgerReach.js";
import { HOME, navigate, projectPage, venture as ventureRoute } from "../router.js";
import { useResource } from "../state/resources.js";
import { byPosition, indexTree, nextPosition, type TreeIndex } from "../treeIndex.js";
import { nested } from "../projectNest.js";
import { currentNames, useLevelWords } from "../levelNames.js";
import { useFirstRun } from "../firstRunState.js";
import { stepSuggestion } from "../firstRunSteps.js";
import { useApp } from "./appContext.js";
import { moveIntoItem } from "./NestPicker.js";
import { AddLine, EditableText, Pending } from "./controls.js";
import { Ledger } from "./Ledger.js";
import { Register } from "./Register.js";
import { useLedgerAsk } from "./useLedgerAsk.js";
import { StagePick } from "./Lifecycle.js";
import { SpaceSettings } from "./SpaceSettings.js";
import { Pick } from "./Picker.js";
import { MoreMenu } from "./Menu.js";
import { NoteLine } from "./NoteLine.js";
import { OrderedRows } from "./OrderedRows.js";
import { RiskTag, riskItem } from "./RiskTag.js";

const ABOUT_KEY = "vemi:venture-about:v1";

function savedAbout(): boolean {
  try {
    return localStorage.getItem(ABOUT_KEY) === "1";
  } catch {
    return false;
  }
}

/**
 * Projects: a venture's projects in its own order, held by the grip (VEMI-006). Nothing sorts
 * itself. Each row carries a matrix of what is done and what is left.
 *
 * A project's name opens its own page (VEMI-007). Everything that is the venture's rather
 * than a project's — its description, its states, notes, what it owns
 * and is linked to — is one row further down, closed until it is asked for: the handoff's
 * "everything secondary hides until asked for", without any of it going away.
 */
export function VenturePage({ ventureId }: { readonly ventureId: string }) {
  const app = useApp();
  const w = useLevelWords();
  const firstRun = useFirstRun();
  const tree = useResource<Tree>(paths.tree);
  const overview = useResource<Overview>(paths.overview);
  const notes = useResource<Note[]>(paths.list("notes", { venture: ventureId }));
  const index = useMemo(() => (tree.data === null ? null : indexTree(tree.data)), [tree.data]);
  // A move waits for the answer that shows the last one.
  const [movedWith, setMovedWith] = useState<{ readonly tree: Tree | null } | null>(null);
  const waiting = movedWith !== null && movedWith.tree === tree.data;
  const [about, setAboutRaw] = useState(savedAbout);
  const [settings, setSettings] = useState(false);
  /** The one project row whose add line is open, if any. */
  const [adding, setAdding] = useState<string | null>(null);
  const setAbout = (next: boolean): void => {
    setAboutRaw(next);
    try {
      localStorage.setItem(ABOUT_KEY, next ? "1" : "0");
    } catch {
      // Remembered for this visit only.
    }
  };

  useLedgerAsk(ventureId, tree.data !== null && about, () => setAbout(true));

  if (index === null) return <Pending error={tree.error} onRetry={tree.refetch} />;
  const venture = index.ventures.get(ventureId);
  if (venture === undefined) return null;

  const kinds = kindsOf(venture);
  const projects = [...venture.projects].sort(byPosition);
  const groups = nested(projects);
  /** A task made from a row is made the one way Add makes one. */
  const send = { act: (work: () => Promise<unknown>) => app.act(work), create: api.create };

  const moveIn = rowMover(app.act, {
    blocked: waiting,
    onSent: () => setMovedWith({ tree: tree.data }),
    onRefused: () => setMovedWith(null),
  });

  return (
    <div className="projects">
      <div className="venture-bar">
        <StagePick kind="ventures" id={venture.id} name={venture.name} stageId={venture.stageId} venture={venture} />
        <RiskTag blocked={venture.blocked} atRisk={venture.atRisk} />
        <button type="button" className="row-action quiet" onClick={() => setSettings(true)}>Settings</button>
      </div>
      {settings && <SpaceSettings ventureId={ventureId} onClose={() => setSettings(false)} />}

      <div className="proj-rows">
        {projects.length === 0 && <div className="rows-empty">{`No ${w.projects.toLowerCase()} yet. ${w.tasks} can sit on the ${w.space.toLowerCase()} itself.`}</div>}
        <OrderedRows items={groups.map((g) => g.project)} className="proj-row" label={(p) => p.name}
          move={moveIn("projects", groups.map((g) => g.project), `the ${w.project.toLowerCase()}`)}
          row={(p, grip) => (
            <ProjectRow ventureId={ventureId} project={p} grip={grip}
              under={<ChildRows ventureId={ventureId} parent={p} inside={groups.find((g) => g.project.id === p.id)?.children ?? []}
                projects={projects} kinds={kinds} move={moveIn} />}
              left={projectCounts(p, kinds).left}
              adding={adding === p.id} onAdding={(open) => setAdding(open ? p.id : null)}
              onAdd={async (title) => {
                const made = await makeTask(send, title, venture, { projectId: p.id });
                if (made === "sent") app.notify(addedTo(venture.name, p.name));
                return made;
              }}
              onAddMany={async (titles) => {
                const made = await makeTasks(tasksSender(app), titles, venture, { projectId: p.id });
                if (made > 0) app.notify(`${addedTo(venture.name, p.name)}: ${made} ${w.tasks.toLowerCase()}, one a line.`, { undo: true });
              }}
              menu={<MoreMenu label={`${w.project.toLowerCase()} ${p.name}`} items={[
                { label: "Open", run: () => navigate(projectPage(ventureId, p.id)) },
                { label: `Add a ${w.task.toLowerCase()} to it`, run: () => app.compose({ ventureId, projectId: p.id }) },
                { label: "Decisions and risks", run: () => { askForLedger(p.id); navigate(projectPage(ventureId, p.id)); } },
                riskItem(app, "projects", p),
                moveIntoItem(app.pickHome, p, projects),
                { label: "Choose an icon", run: () => app.pickIcon({ kind: "projects", id: p.id, label: p.name, current: p.icon }) },
                { label: `Archive ${w.project.toLowerCase()}`, tone: "remove", run: () => void app.archive("projects", p.id, w.project.toLowerCase()) },
              ]} />} />
          )} />
      </div>
      <div className="rows-add">
        <AddLine placeholder={(firstRun.step === 3 ? stepSuggestion(3, currentNames()) : null) ?? `a new ${w.project.toLowerCase()}`}
          label={`Add ${w.project.toLowerCase()}`} cue={firstRun.step === 3}
          onAdd={(name) => app.act(createOnce("projects", { ventureId, name, position: nextPosition(projects) }))} />
      </div>

      <div id="about" className={`proj-row about-row${about ? " open" : ""}`}>
        <button type="button" className="about-toggle" aria-expanded={about} onClick={() => setAbout(!about)}>
          <span className="about-title">About {venture.name}</span>
          <span className="about-what">Description, links, states, notes, decisions and risks</span>
          <span className="row-action">{about ? "Hide" : "Show"}</span>
        </button>
      </div>
      {about && (
        <About index={index} ventureId={ventureId} overview={overview.data}
          notes={notes.data ?? []} />
      )}
    </div>
  );
}

/**
 * One project: the grip, its name, what is done and what is left. Its name opens its page.
 *
 * Add task opens one line under the row that makes a task already in this project, the
 * way the notes and links add. The menu's "Add a task to it" is the same task in Add, for
 * when the project, or anything else, should be changed before it is made.
 */
function ProjectRow({ ventureId, project, grip, left, menu, adding, onAdding, onAdd, onAddMany, under }: {
  readonly ventureId: string;
  readonly project: TreeProject;
  readonly grip: ReactNode;
  /** The projects inside this one, drawn beneath its line. */
  readonly under?: ReactNode;
  readonly left: number;
  readonly menu?: ReactNode;
  readonly adding: boolean;
  readonly onAdding: (open: boolean) => void;
  readonly onAdd: (title: string) => Promise<Outcome | boolean>;
  /** A paste of several lines: one task a line. */
  readonly onAddMany: (titles: readonly string[]) => Promise<void>;
}) {
  const w = useLevelWords();
  const line = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (adding) line.current?.querySelector("input")?.focus();
  }, [adding]);
  // No wrapper here: OrderedRows draws the row, so that it can move it.
  return (
    <>
      {/* The whole row opens the project, not only its name: a press anywhere that is not one
          of its own controls is the name's press. The name stays the button a keyboard reaches. */}
      <div className="proj-line" data-hold onClick={(e) => {
        if ((e.target as Element).closest("button, a, input, textarea, [data-more], [role='menu'], .grip") !== null) return;
        navigate(projectPage(ventureId, project.id));
      }}>
        {grip ?? <span className="grip-space" aria-hidden="true" />}
        <button type="button" className="proj-title" dir="auto" title={project.name} onClick={() => navigate(projectPage(ventureId, project.id))}>{project.name}</button>
        <RiskTag blocked={project.blocked} atRisk={project.atRisk} />
        <span className="proj-figures">
          <button type="button" className="row-action quiet" aria-expanded={adding} onClick={() => onAdding(!adding)}>
            {adding ? "Close" : `Add ${w.task.toLowerCase()}`}
          </button>
          <span className="proj-left">{left} left</span>
          {menu}
        </span>
      </div>
      {/* The line's field keeps its Escape to itself, so it is handed the close; the
          wrapper's is for Escape pressed on the line's button. */}
      {adding && (
        <div className="proj-more" ref={line}
          onKeyDown={(e) => { if (e.key === "Escape") onAdding(false); }}>
          <AddLine placeholder={`a new ${w.task.toLowerCase()} in ${project.name}`} label="Add" onAdd={onAdd} onAddMany={onAddMany} onEscape={() => onAdding(false)} />
        </div>
      )}
      {under}
    </>
  );
}

/**
 * The projects inside one: indented rows, each with its name opening its page, its marks, what
 * is left and done, and a ⋯. They reorder among themselves only. Shared with the parent's page.
 */
export function ChildRows({ ventureId, parent, inside, projects, kinds, move }: {
  readonly ventureId: string;
  readonly parent: TreeProject;
  readonly inside: readonly TreeProject[];
  /** Every project of the venture: what the ⋯ asks for "Move into…". */
  readonly projects: readonly TreeProject[];
  readonly kinds: ReturnType<typeof kindsOf>;
  readonly move: (kind: "projects", items: readonly Placed[], what: string) => (id: string, to: number) => void;
}) {
  const app = useApp();
  const w = useLevelWords();
  if (inside.length === 0) return null;
  return (
    <div className="proj-children" aria-label={`${w.projects.toLowerCase()} inside ${parent.name}`}>
      <OrderedRows items={inside} className="proj-child" label={(c) => c.name} move={move("projects", inside, `the ${w.project.toLowerCase()}`)}
        row={(c, grip) => {
          const counts = projectCounts(c, kinds);
          return (
            <div className="proj-line" data-hold>
              {grip ?? <span className="grip-space" aria-hidden="true" />}
              <button type="button" className="proj-title" dir="auto" title={c.name} onClick={() => navigate(projectPage(ventureId, c.id))}>{c.name}</button>
              <RiskTag blocked={c.blocked} atRisk={c.atRisk} />
              <span className="proj-figures">
                <span className="proj-left">{counts.left} left</span>
                <MoreMenu label={`${w.project.toLowerCase()} ${c.name}`} items={[
                  { label: "Open", run: () => navigate(projectPage(ventureId, c.id)) },
                  { label: `Add a ${w.task.toLowerCase()} to it`, run: () => app.compose({ ventureId, projectId: c.id }) },
                  riskItem(app, "projects", c),
                  moveIntoItem(app.pickHome, c, projects),
                  { label: "Choose an icon", run: () => app.pickIcon({ kind: "projects", id: c.id, label: c.name, current: c.icon }) },
                  { label: `Archive ${w.project.toLowerCase()}`, tone: "remove", run: () => void app.archive("projects", c.id, w.project.toLowerCase()) },
                ]} />
              </span>
            </div>
          );
        }} />
    </div>
  );
}

/** Everything that is the venture's own rather than a project's. */
function About({ index, ventureId, overview, notes }: {
  readonly index: TreeIndex;
  readonly ventureId: string;
  readonly overview: Overview | null;
  readonly notes: readonly Note[];
}) {
  const app = useApp();
  const w = useLevelWords();
  const venture = index.ventures.get(ventureId);
  if (venture === undefined) return null;
  const kids = index.children.get(ventureId) ?? [];
  const parent = venture.parentId === null ? null : index.ventures.get(venture.parentId) ?? null;
  const f = overview?.ventures.find((v) => v.id === ventureId)?.total ?? null;
  // `held` is the way back a field had on screen, which can be a save ahead of `venture`.
  const update = (patch: Record<string, unknown>, what: string, held?: Record<string, unknown>) =>
    app.edit("ventures", ventureId, patch, held ?? venture, what);
  // Two levels: a venture with children cannot take a parent, and only a top-level venture can be one.
  const parents = kids.length > 0 ? [] : index.top.filter((v) => v.id !== ventureId);

  const archiveVenture = async (): Promise<void> => {
    if (await app.archive("ventures", ventureId, w.space.toLowerCase())) navigate(HOME);
  };

  return (
    <div className="about">
      <section className="about-block">
        <div className="kicker more-kicker">Description</div>
        <div className="about-goal">
          <EditableText value={venture.description} placeholder="What is this, in one sentence?" allowEmpty onSave={(description, was) => update({ description }, `edited the description of ${venture.name}`, { description: was })} />
        </div>
        {f !== null && (
          <p className="about-said">
            {f.underway} underway · {f.blocked} blocked · {f.tasksLeft} left
            {f.nextMilestone !== null && <> · next {w.milestone.toLowerCase()} {f.nextMilestone.name}{f.nextMilestone.aimingOn !== null && `, aiming at ${shortDate(f.nextMilestone.aimingOn, app.today)}`}</>}
            {kids.length > 0 && `, counting the ${w.spaces.toLowerCase()} it owns`}
          </p>
        )}
      </section>

      <Register ventureId={ventureId} />

      <section className="about-block">
        <div className="kicker more-kicker">Name and icon</div>
        <div className="more-line">
          <EditableText value={venture.name} placeholder="name" onSave={(name, was) => update({ name }, `renamed ${venture.name}`, { name: was })} />
          <button type="button" className="icon-button small" title="change icon" aria-label="change icon"
            onClick={() => app.pickIcon({ kind: "ventures", id: venture.id, label: venture.name, current: venture.icon })}>
            {venture.icon === null ? <span className="dim">+</span> : <Icon name={venture.icon} size={14} />}
          </button>
        </div>
      </section>

      <section className="about-block">
        <div className="kicker more-kicker">Notes</div>
        {notes.map((n) => <NoteLine key={n.id} note={n} also={attachedTo(n, w.project.toLowerCase())} />)}
        <AddLine placeholder="a short note" label="Add note" onAdd={(body) => app.act(createOnce("notes", { ventureId, body }))} />
      </section>

      <Ledger ventureId={ventureId} />

      <section className="about-block">
        <div className="kicker more-kicker">Ownership</div>
        {parent !== null && (
          <p className="about-said">
            Owned by <button type="button" className="link-button" onClick={() => navigate(ventureRoute(parent.id, "projects"))}>{parent.name}</button>
          </p>
        )}
        {kids.length > 0 && (
          <p className="about-said">
            Owns {kids.map((k, i) => (
              <span key={k.id}>{i > 0 && ", "}<button type="button" className="link-button" onClick={() => navigate(ventureRoute(k.id, "projects"))}>{k.name}</button></span>
            ))}
          </p>
        )}
        {parents.length > 0 && (
          <div className="more-line">
            <span className="more-note">Belongs to</span>
            <Pick label="owner" value={venture.parentId ?? ""} className="pick-inline"
              onPick={(id) => void update({ parentId: id === "" ? null : id }, `changed who owns ${venture.name}`)}
              options={[{ id: "", name: `Nothing: a ${w.space.toLowerCase()} of its own` }, ...parents.map((p) => ({ id: p.id, name: p.name }))]} />
          </div>
        )}
      </section>

      <div className="more-foot">
        <button type="button" className="row-action" onClick={() => void archiveVenture()}>Archive {w.space.toLowerCase()}</button>
      </div>
    </div>
  );
}

function attachedTo(note: Note, project: string): string {
  return note.projectId !== null ? ` · on a ${project}` : "";
}
