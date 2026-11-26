/**
 * A board column is a grouping, not a state. Pure: a venture in, columns out.
 *
 * A column carries a key, a name and a kind, and the kind is null for everything but a
 * state. Colour carries state and nothing else, which is why only a state column has a dot
 * to draw. The board groups by state or by project.
 *
 * Nothing here decides the order of cards inside a column beyond the order `tasksOf` gives
 * them, which is `position`. Whether a column can be reordered by hand is the board's
 * question, not this module's.
 */
import { type StateKind, type TaskWithBlocker, type TreeVenture } from "@vemi/shared";
import { inOrder, pathOf } from "./projectNest.js";
import { fallbackState, orderedStates, stateOf, tasksOf } from "./treeIndex.js";

export const GROUPINGS = ["state", "project"] as const;
export type Grouping = (typeof GROUPINGS)[number];

export interface Column {
  /** A state id or a project id, or `""`, the one column for having none. */
  readonly key: string;
  readonly name: string;
  /** Only a state column has one, and it is what draws the dot. */
  readonly kind: StateKind | null;
  readonly tasks: readonly TaskWithBlocker[];
}

/** The column for tasks that have none of whatever this grouping groups by. Always last. */
const none = (name: string, tasks: readonly TaskWithBlocker[]): Column => ({ key: "", name, kind: null, tasks });

/**
 * One column per state, in the venture's own order. A task with no state sits in the first
 * not-started column, the same fallback `boardColumns` has always used.
 */
function byState(venture: TreeVenture): Column[] {
  const all = tasksOf(venture);
  const fallback = fallbackState(venture);
  return orderedStates(venture).map((state) => ({
    key: state.id,
    name: state.name,
    kind: state.kind,
    tasks: all.filter((t) => (stateOf(t, venture) ?? fallback)?.id === state.id),
  }));
}

/**
 * One column per project, a parent followed by its children ("Parent › Child"), then No project.
 *
 * A task whose project is not one of this venture's falls into No project rather than out of
 * the board: a card that is nowhere cannot be found and cannot be moved back.
 */
function byProject(venture: TreeVenture): Column[] {
  const all = tasksOf(venture);
  const projects = inOrder(venture.projects);
  return [
    ...projects.map((p) => ({
      key: p.id,
      name: pathOf(p, projects),
      kind: null,
      tasks: all.filter((t) => t.projectId === p.id),
    })),
    none("No project", all.filter((t) => !projects.some((p) => p.id === t.projectId))),
  ];
}

/**
 * The board's columns under one grouping.
 *
 * Every task of the venture is here, its projects' included, in `position` order.
 */
export function columnsFor(venture: TreeVenture, grouping: Grouping): Column[] {
  switch (grouping) {
    case "state": return byState(venture);
    case "project": return byProject(venture);
  }
}
