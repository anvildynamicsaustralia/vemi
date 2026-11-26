/**
 * The tree, indexed for the surfaces that read it. Pure: a `Tree` in, lookups out.
 *
 * Nothing here compares a date with today. Overdue comes from `/api/today`, which is the one
 * place it is computed.
 */
import type { DateOnly, State, StateKind, TaskWithBlocker, Today, Tree, TreeProject, TreeVenture } from "@vemi/shared";

export interface Located {
  readonly task: TaskWithBlocker;
  readonly venture: TreeVenture;
  readonly project: TreeProject | null;
}

export interface TreeIndex {
  readonly ventures: ReadonlyMap<string, TreeVenture>;
  /** Ventures with no parent, in order. */
  readonly top: readonly TreeVenture[];
  /** Every venture: each top-level one followed by its children. */
  readonly ordered: readonly TreeVenture[];
  readonly children: ReadonlyMap<string, readonly TreeVenture[]>;
  readonly tasks: ReadonlyMap<string, Located>;
}

interface Placed {
  readonly position: number;
  readonly createdAt: string;
}

export const byPosition = (a: Placed, b: Placed): number =>
  a.position - b.position || a.createdAt.localeCompare(b.createdAt);

export function indexTree(tree: Tree): TreeIndex {
  const ventures = new Map(tree.ventures.map((v) => [v.id, v]));
  const children = new Map<string, TreeVenture[]>();
  const top: TreeVenture[] = [];
  for (const venture of [...tree.ventures].sort(byPosition)) {
    if (venture.parentId !== null && ventures.has(venture.parentId)) {
      const list = children.get(venture.parentId) ?? [];
      list.push(venture);
      children.set(venture.parentId, list);
    } else {
      top.push(venture);
    }
  }

  const tasks = new Map<string, Located>();
  for (const venture of tree.ventures) {
    for (const task of venture.tasks) tasks.set(task.id, { task, venture, project: null });
    for (const project of venture.projects) {
      for (const task of project.tasks) tasks.set(task.id, { task, venture, project });
    }
  }

  return {
    ventures,
    top,
    ordered: top.flatMap((v) => [v, ...(children.get(v.id) ?? [])]),
    children,
    tasks,
  };
}

export function orderedStates(venture: TreeVenture): State[] {
  return [...venture.states].sort(byPosition);
}

export function firstOfKind(venture: TreeVenture, kind: StateKind): State | null {
  return orderedStates(venture).find((s) => s.kind === kind) ?? null;
}

export function stateOf(task: TaskWithBlocker, venture: TreeVenture): State | null {
  return task.stateId === null ? null : venture.states.find((s) => s.id === task.stateId) ?? null;
}

/** A task with no state counts as not started. */
export function kindOf(task: TaskWithBlocker, venture: TreeVenture): StateKind {
  return stateOf(task, venture)?.kind ?? "not_started";
}

/** Every task in a venture, its own and its projects', in order. */
export function tasksOf(venture: TreeVenture): TaskWithBlocker[] {
  return [...venture.tasks, ...venture.projects.flatMap((p) => p.tasks)].sort(byPosition);
}

/**
 * The column a task with no state of its own sits in: the first not-started one, or simply the
 * first there is, or nothing at all in a venture with no states.
 *
 * Its own function, and not `boardGroups.ts`'s own, because the fallback is a fact about a
 * venture's states rather than about a column: `kindOf` says the same thing about a task
 * with no state, and a board where the two disagreed would put a card in one column and
 * look for it in another.
 */
export function fallbackState(venture: TreeVenture): State | null {
  const states = orderedStates(venture);
  return states.find((s) => s.kind === "not_started") ?? states[0] ?? null;
}

export interface Attention {
  readonly kind: "overdue" | "blocked";
  readonly task: TaskWithBlocker;
  readonly venture: TreeVenture;
}

/**
 * The needs-you panel: overdue and blocked, and nothing else. The tool never picks work.
 * A task both overdue and blocked is listed once, as blocked, because the reason is the
 * more useful thing to read.
 */
export function needsYou(index: TreeIndex, today: Today | null): Attention[] {
  const blocked: Attention[] = [];
  for (const venture of index.ordered) {
    for (const task of tasksOf(venture)) {
      if (task.blocker !== null && kindOf(task, venture) !== "finished") blocked.push({ kind: "blocked", task, venture });
    }
  }
  const listed = new Set(blocked.map((a) => a.task.id));
  const overdue: Attention[] = [];
  for (const t of today?.tasks ?? []) {
    if (!t.overdue || listed.has(t.id)) continue;
    const at = index.tasks.get(t.id);
    if (at !== undefined) overdue.push({ kind: "overdue", task: at.task, venture: at.venture });
  }
  return [...overdue, ...blocked];
}

/** What could be picked for today: unfinished, unblocked, not already picked. In venture order. */
export function pickable(index: TreeIndex, on: DateOnly, limit = 12): Located[] {
  const out: Located[] = [];
  for (const venture of index.ordered) {
    for (const task of tasksOf(venture)) {
      if (out.length >= limit) return out;
      if (task.pickedOn === on || task.blocker !== null || kindOf(task, venture) === "finished") continue;
      const at = index.tasks.get(task.id);
      if (at !== undefined) out.push(at);
    }
  }
  return out;
}

/** The next position at the end of a list. */
export function nextPosition(items: readonly { readonly position: number }[]): number {
  return items.reduce((max, item) => Math.max(max, item.position), 0) + 1;
}
