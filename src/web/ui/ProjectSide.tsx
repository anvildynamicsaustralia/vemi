import { useEffect, useState } from "react";
import type { Link, TreeProject, TreeVenture } from "@vemi/shared";
import { api, createOnce, paths } from "../api.js";
import { kindsOf, projectCounts } from "../counts.js";
import { lastPushHere, parseRepo, type RepoStorage } from "../githubRepo.js";
import { isLocal } from "../local/mode.js";
import { useLevelWords } from "../levelNames.js";
import { levelWords, type LevelNames } from "../levelWords.js";
import { projectBrief } from "../projectBrief.js";
import { projectNext, type NextStep } from "../projectNext.js";
import { useResource } from "../state/resources.js";
import { tickTask } from "../tickTask.js";
import { byPosition } from "../treeIndex.js";
import { useApp } from "./appContext.js";
import "./projectSide.css";

/**
 * The side column of a project's page (VEMI-013, project phase): the Next step, a few figures
 * and the project's two links, a GitHub repo and a live site. The figures and the links are
 * hidden on a phone; the page shows `ProjectLinks` under Notes there instead.
 */

export interface StepWords {
  readonly title: string;
  readonly note: string;
  readonly go: string;
}

/** What the Next step card says. Names come from the space's own words, never a fixed level word. */
export function stepWords(
  step: NextStep,
  from: {
    readonly brief: readonly string[];
    readonly tasks: readonly { readonly id: string; readonly title: string }[];
    readonly milestones: readonly { readonly id: string; readonly name: string }[];
    readonly names?: Partial<LevelNames>;
  },
): StepWords {
  const words = levelWords(from.names);
  const milestone = words.milestone.toLowerCase();
  const task = words.task.toLowerCase();
  switch (step.kind) {
    case "brief":
      return { title: `Fill in: ${from.brief[step.step] ?? "the Brief"}`, note: "Brief", go: "Write it" };
    case "milestone":
      return { title: `Add your first ${milestone}`, note: words.milestones, go: `Add ${milestone}` };
    case "task": {
      const title = from.tasks.find((t) => t.id === step.taskId)?.title ?? "";
      const where = from.milestones.find((m) => m.id === step.milestoneId)?.name;
      return { title, note: where ?? `No ${milestone}`, go: "Done" };
    }
    case "addTask": {
      const where = from.milestones.find((m) => m.id === step.milestoneId)?.name;
      return { title: where === undefined ? `Add a ${task}` : `Add a ${task} to ${where}`, note: where ?? words.tasks, go: `Add ${task}` };
    }
  }
}

export function NextCard({ title, note, go, isTask, onGo }: {
  readonly title: string;
  readonly note: string;
  readonly go: string;
  readonly isTask: boolean;
  readonly onGo: () => void;
}) {
  return (
    <div className="card side-next">
      <span className="side-k">Next step</span>
      <b className="side-next-title">{title}</b>
      {note !== "" && <small className="side-next-note">{note}</small>}
      <button type="button" className={isTask ? "side-done" : "side-go"} onClick={onGo}>
        {isTask && (
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m5.5 12.5 4 4 9-9" /></svg>
        )}
        {go}
      </button>
    </div>
  );
}

export function StatsCard({ left, done, milestones, words }: {
  readonly left: number;
  readonly done: number;
  readonly milestones: number;
  readonly words: { readonly milestones: string };
}) {
  return (
    <div className="card side-stats">
      <div><b>{left}</b><small>Left</small></div>
      <div><b>{done}</b><small>Done</small></div>
      <div><b>{milestones}</b><small>{words.milestones}</small></div>
    </div>
  );
}

/** A live site's address as the person wrote it, made whole: https is assumed, other schemes refused. */
export function siteUrl(raw: string): string | null {
  const text = raw.trim();
  if (text === "") return null;
  if (!/^https?:\/\//i.test(text) && /^[a-z][a-z0-9+.-]*:(?!\d)/i.test(text)) return null;
  try {
    const url = new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

type Role = "repo" | "site";
type Saved = Promise<unknown> | boolean | void;

const repoName = (url: string): string => {
  const repo = parseRepo(url);
  return repo === null ? url : `${repo.owner}/${repo.name}`;
};

const siteName = (url: string): string => url.replace(/^https?:\/\//i, "").replace(/\/$/, "");

const REPO_ICON = (
  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="7" cy="6" r="2" /><circle cx="7" cy="18" r="2" /><circle cx="17" cy="8" r="2" /><path d="M7 8v8M17 10c0 4-10 2-10 6" /></svg>
);
const SITE_ICON = (
  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" /></svg>
);

/**
 * The two links. Each is made or changed in place: a click on the empty row, or on Change,
 * opens a field; Enter saves and Escape leaves. `push` is the repo's last push, or null, in
 * which case the row shows the link alone.
 */
export function LinksCard({ repo, site, push, onSave, className = "" }: {
  readonly repo: Link | null;
  readonly site: Link | null;
  readonly push: string | null;
  /** Answers false when the value was refused or the write did not happen. */
  readonly onSave: (role: Role, value: string, was: Link | null) => Saved;
  readonly className?: string;
}) {
  const [editing, setEditing] = useState<Role | null>(null);
  const commit = (role: Role, was: Link | null, value: string): void => {
    const next = value.trim();
    if (next === "") { setEditing(null); return; }
    void Promise.resolve(onSave(role, next, was)).then((r) => { if (r !== false) setEditing(null); });
  };
  const field = (role: Role, was: Link | null) => (
    <span className="lk lk-edit">
      {role === "repo" ? REPO_ICON : SITE_ICON}
      <input autoFocus defaultValue={was === null ? "" : was.url} aria-label={role === "repo" ? "GitHub repo" : "Live site"}
        placeholder={role === "repo" ? "owner/repo" : "https://"}
        onKeyDown={(e) => {
          if (e.key === "Enter") { e.preventDefault(); commit(role, was, e.currentTarget.value); }
          else if (e.key === "Escape") { e.stopPropagation(); setEditing(null); }
        }} />
    </span>
  );
  return (
    <div className={`side-links ${className}`.trim()}>
      <h3 className="side-h">Links</h3>
      <div className="card links">
        {editing === "repo" ? field("repo", repo) : repo !== null ? (
          <div className="lk-row">
            <a className="lk" href={repo.url} target="_blank" rel="noopener noreferrer">
              {REPO_ICON}
              <span><b>{repoName(repo.url)}</b>{push !== null && <small>Last push {push.slice(0, 10)}</small>}</span>
            </a>
            <button type="button" className="lk-change" onClick={() => setEditing("repo")}>Change</button>
          </div>
        ) : (
          <button type="button" className="lk" onClick={() => setEditing("repo")}>
            {REPO_ICON}<span><b>Link a GitHub repo</b><small>Shows when it was last pushed</small></span>
          </button>
        )}
        {editing === "site" ? field("site", site) : site !== null ? (
          <div className="lk-row">
            <a className="lk" href={site.url} target="_blank" rel="noopener noreferrer">
              {SITE_ICON}
              <span><b>{siteName(site.url)}</b><small>Live site</small></span>
            </a>
            <button type="button" className="lk-change" onClick={() => setEditing("site")}>Change</button>
          </div>
        ) : (
          <button type="button" className="lk" onClick={() => setEditing("site")}>
            {SITE_ICON}<span><b>Link a live site</b><small>Where it runs</small></span>
          </button>
        )}
      </div>
    </div>
  );
}

const browserStorage = (): RepoStorage => {
  try {
    return window.localStorage;
  } catch {
    return { getItem: () => null, setItem: () => undefined };
  }
};

/** The project's repo and site links, written in place, and the repo's last push once known. */
function useProjectLinks(projectId: string) {
  const app = useApp();
  const links = useResource<Link[]>(paths.list("links", { project: projectId }));
  const find = (role: Role): Link | null => (links.data ?? []).find((l) => l.role === role) ?? null;
  const repo = find("repo");
  const site = find("site");
  const repoUrl = repo?.url ?? null;
  const [push, setPush] = useState<{ readonly url: string; readonly at: string } | null>(null);

  useEffect(() => {
    const parsed = repoUrl === null ? null : parseRepo(repoUrl);
    if (repoUrl === null || parsed === null) return;
    let live = true;
    void lastPushHere(parsed, (u) => fetch(u), browserStorage(), isLocal()).then((at) => {
      if (live && at !== null) setPush({ url: repoUrl, at });
    });
    return () => { live = false; };
  }, [repoUrl]);

  const save = async (role: Role, value: string, was: Link | null): Promise<boolean> => {
    const url = role === "repo" ? parseRepo(value)?.url ?? null : siteUrl(value);
    if (url === null) {
      app.notify(role === "repo" ? "That is not a GitHub repo. Write it as owner/name." : "That is not a web address.");
      return false;
    }
    if (was !== null && was.url === url) return true;
    const what = was === null ? `linked the ${role}` : `changed the ${role} link`;
    const done = was === null
      ? await app.act(createOnce("links", { projectId, url, role }))
      : await app.edit("links", was.id, { url }, { url: was.url }, what);
    return done !== false;
  };

  return { repo, site, push: push !== null && push.url === repoUrl ? push.at : null, save };
}

/** The links, connected. The page puts this under Notes on a phone; the side column holds its own copy on a desk. */
export function ProjectLinks({ projectId, className }: { readonly projectId: string; readonly className?: string }) {
  const { repo, site, push, save } = useProjectLinks(projectId);
  return <LinksCard repo={repo} site={site} push={push} onSave={save} {...(className === undefined ? {} : { className })} />;
}

/**
 * The column itself. `selectedMilestoneId` is the milestone the page has open, which the Next
 * step prefers; `onGo` takes the person to the place a non-task step names.
 */
export function ProjectSide({ venture, project, selectedMilestoneId, onGo }: {
  readonly venture: TreeVenture;
  readonly project: TreeProject;
  readonly selectedMilestoneId: string | null;
  readonly onGo: (step: NextStep) => void;
}) {
  const app = useApp();
  const words = useLevelWords();
  const kinds = kindsOf(venture);
  const counts = projectCounts(project, kinds);
  const milestones = [...project.milestones];
  const tasks = [...project.tasks].sort(byPosition).map((t) => ({
    id: t.id,
    title: t.title,
    milestoneId: t.milestoneId,
    done: t.stateId !== null && kinds.get(t.stateId) === "finished",
  }));
  const step = projectNext({ brief: project, milestones, tasks, selectedMilestoneId });
  const say = stepWords(step, {
    brief: projectBrief(project).steps.map((s) => s.label),
    tasks,
    milestones,
    names: words,
  });
  const finish = (taskId: string): void => {
    const task = project.tasks.find((t) => t.id === taskId);
    if (task === undefined) return;
    void tickTask({ act: app.act, update: api.update, archive: api.archive, notify: app.notify }, task, venture, false);
  };

  return (
    <aside className="side" aria-label="Next step and links">
      <NextCard title={say.title} note={say.note} go={say.go} isTask={step.kind === "task"}
        onGo={() => (step.kind === "task" ? finish(step.taskId) : onGo(step))} />
      <StatsCard left={counts.left} done={counts.done} milestones={milestones.length} words={words} />
      <ProjectLinks projectId={project.id} />
    </aside>
  );
}
