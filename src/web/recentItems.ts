/**
 * The tasks touched last, across every space. Pure: a `Tree` in, a short list out.
 *
 * No new column, no new read path and nothing to keep up. `updatedAt` is on every record,
 * and the one statement builder every patch goes through writes it unconditionally, so
 * "what was touched" is a sort of what the map already holds.
 *
 * **Tasks only, and nothing else is excluded.** A finished task that was just edited *was*
 * touched. The one exclusion is the archived, and `tree()` has already made it:
 * archiving puts something out of sight, and Recent does not bring it back.
 */
import type { Tree } from "@vemi/shared";

export interface Touched {
  readonly id: string;
  readonly kind: "venture" | "project" | "milestone" | "task";
  readonly title: string;
  readonly ventureId: string;
  /** For a task: the name of its project, or null when it has none. */
  readonly projectName?: string | null;
  /** The ISO `updatedAt`, rendered by `age()`. */
  readonly at: string;
  /** The app that touched this task last, when no one has since. Absent otherwise. */
  readonly via?: string;
}

/** The part of a connector change Recent needs: which record, whose app, and when. */
export interface ViaChange {
  readonly kind: string;
  readonly recordId: string;
  readonly clientName: string;
  readonly createdAt: string;
  readonly undoneAt: string | null;
}

/** Newest first, tie-broken by id so the order holds still across renders. */
const newestFirst = (a: Touched, b: Touched): number =>
  a.at < b.at ? 1 : a.at > b.at ? -1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;

/** The `most` tasks touched last, newest first. */
export function recentItems(tree: Tree, most: number, changes: readonly ViaChange[] = []): readonly Touched[] {
  const all: Touched[] = [];
  // The newest change by an app, per task. An undone one put the old values back as a hand
  // would, and a task touched after its change was last touched by someone else.
  const latest = new Map<string, ViaChange>();
  for (const c of changes) {
    if (c.kind !== "tasks" || c.undoneAt !== null) continue;
    const seen = latest.get(c.recordId);
    if (seen === undefined || c.createdAt > seen.createdAt) latest.set(c.recordId, c);
  }
  const touched = (t: { id: string; updatedAt: string }): { via?: string } => {
    const c = latest.get(t.id);
    return c !== undefined && c.createdAt >= t.updatedAt ? { via: c.clientName } : {};
  };
  for (const venture of tree.ventures) {
    const ventureId = venture.id;
    for (const task of venture.tasks) {
      all.push({ id: task.id, kind: "task", title: task.title, ventureId, projectName: null, at: task.updatedAt, ...touched(task) });
    }
    for (const project of venture.projects) {
      for (const task of project.tasks) {
        all.push({ id: task.id, kind: "task", title: task.title, ventureId, projectName: project.name, at: task.updatedAt, ...touched(task) });
      }
    }
  }
  return all.sort(newestFirst).slice(0, Math.max(0, most));
}
