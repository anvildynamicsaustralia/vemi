/**
 * A project's tasks sorted under its milestones (VEMI-013). A task whose milestone is not one
 * of the project's, or that has none, sits in the "No milestone" group, so no task is hidden.
 * Pure. Nothing here reads a milestone's date: it is soft, and only the Worker orders by it.
 */
import type { StateKind } from "@vemi/shared";
import { countTasks, type Counts } from "./counts.js";
import { byPosition } from "./treeIndex.js";

interface Grouped {
  readonly id: string;
  readonly milestoneId: string | null;
  readonly stateId: string | null;
  readonly position: number;
  readonly createdAt: string;
}

export interface MilestoneGroup<M, T> {
  readonly milestone: M;
  readonly tasks: readonly T[];
  readonly counts: Counts;
}

export interface MilestoneGroups<M, T> {
  readonly milestones: readonly MilestoneGroup<M, T>[];
  readonly none: { readonly tasks: readonly T[]; readonly counts: Counts };
}

export function milestoneGroups<M extends { readonly id: string }, T extends Grouped>(
  project: { readonly milestones: readonly M[]; readonly tasks: readonly T[] },
  kinds: ReadonlyMap<string, StateKind>,
): MilestoneGroups<M, T> {
  const ids = new Set(project.milestones.map((m) => m.id));
  const sorted = [...project.tasks].sort(byPosition);
  const loose = sorted.filter((t) => t.milestoneId === null || !ids.has(t.milestoneId));
  return {
    milestones: project.milestones.map((milestone) => {
      const tasks = sorted.filter((t) => t.milestoneId === milestone.id);
      return { milestone, tasks, counts: countTasks(tasks, kinds) };
    }),
    none: { tasks: loose, counts: countTasks(loose, kinds) },
  };
}

/** What a milestone card says under its name. */
export const remainingWords = (c: Counts): string =>
  c.left === 0 && c.done > 0 ? "Done" : `${c.left} left`;
