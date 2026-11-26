/**
 * The map's plates as data. Pure.
 *
 * A plate is a top-level space: its letters, name, stage, up to two flags, and a ring of the
 * tasks left; then its projects, pinned first and then in their own order. A space nested in
 * it comes as an inner plate. Every flag and every dot reads what is already stored or what
 * the Today list already says: nothing here computes lateness from a date.
 */
import type { Overview, Today, Tree, TreeProject, TreeVenture } from "@vemi/shared";
import { countTasks, kindsOf, type Counts } from "./counts.js";
import { mapLetters } from "./monogram.js";

/** Projects a plate shows before "N more". */
export const PLATE_ROWS = 3;
/** Flags a plate shows, in priority order. */
export const PLATE_FLAGS = 2;

export type Flag = "blocked" | "overdue" | "at risk";
/** Highest first: blocked, then overdue, then at risk. */
const FLAG_ORDER: readonly Flag[] = ["blocked", "overdue", "at risk"];

export interface PlateProject {
  readonly id: string;
  readonly ventureId: string;
  readonly name: string;
  readonly pinned: boolean;
  /** The one flag the row shows in place of its stage, or null. */
  readonly flag: Flag | null;
  readonly stage: string | null;
  readonly left: number;
  readonly done: number;
  /** One of its tasks is picked for today. */
  readonly onToday: boolean;
}

export interface Plate {
  readonly id: string;
  readonly name: string;
  readonly icon: string | null;
  readonly letters: string;
  readonly stage: string | null;
  /** At most `PLATE_FLAGS`, highest first. */
  readonly flags: readonly Flag[];
  /** Tasks left and done in this space and the spaces nested in it. */
  readonly counts: Counts;
  readonly projects: readonly PlateProject[];
  readonly inner: readonly Plate[];
}

/** How many projects are behind "N more" while the plate is closed. */
export const hiddenProjects = (list: readonly unknown[]): number => Math.max(0, list.length - PLATE_ROWS);

const flagsOf = (set: ReadonlySet<Flag>): Flag[] => FLAG_ORDER.filter((f) => set.has(f));

type Orderable = Pick<TreeProject, "pinnedAt" | "position" | "id">;

/** Pinned first, then position, then id: the same order every time. */
export function projectOrder(a: Orderable, b: Orderable): number {
  const pa = a.pinnedAt === null ? 1 : 0;
  const pb = b.pinnedAt === null ? 1 : 0;
  return pa - pb || a.position - b.position || a.id.localeCompare(b.id);
}

export function plates(overview: Overview, tree: Tree, today: Today | null): Plate[] {
  const byId = new Map<string, TreeVenture>(tree.ventures.map((v) => [v.id, v]));
  const overdue = new Set((today?.tasks ?? []).filter((t) => t.overdue).map((t) => t.id));
  const picked = new Set((today?.tasks ?? []).filter((t) => t.picked).map((t) => t.id));
  const letters = mapLetters(overview.ventures.map((v) => ({ ...v, monogram: byId.get(v.id)?.monogram ?? null })));
  const ordered = [...overview.ventures].sort((a, b) => a.position - b.position || a.id.localeCompare(b.id));
  const kids = new Map<string, string[]>();
  const roots: string[] = [];
  for (const v of ordered) {
    if (!byId.has(v.id)) continue;
    if (v.parentId !== null && v.parentId !== v.id && byId.has(v.parentId)) {
      kids.set(v.parentId, [...(kids.get(v.parentId) ?? []), v.id]);
    } else roots.push(v.id);
  }

  /** The plate, and every flag beneath it before the cap, so a parent still sees a child's. */
  const build = (id: string, seen: Set<string>): { readonly plate: Plate; readonly all: ReadonlySet<Flag> } | null => {
    const v = byId.get(id);
    if (v === undefined || seen.has(id)) return null;
    seen.add(id);
    const states = kindsOf(v);
    const stages = new Map(v.stages.map((s) => [s.id, s.name]));
    const rows: PlateProject[] = [...v.projects].sort(projectOrder).map((p) => {
      const c = countTasks(p.tasks, states);
      const has = new Set<Flag>();
      if (p.blocked) has.add("blocked");
      if (p.tasks.some((t) => overdue.has(t.id))) has.add("overdue");
      if (p.atRisk) has.add("at risk");
      return {
        id: p.id, ventureId: v.id, name: p.name, pinned: p.pinnedAt !== null,
        flag: flagsOf(has)[0] ?? null,
        stage: p.stageId === null ? null : stages.get(p.stageId) ?? null,
        left: c.left, done: c.done,
        onToday: p.tasks.some((t) => picked.has(t.id)),
      };
    });
    const inner = (kids.get(id) ?? []).map((k) => build(k, seen)).filter((p) => p !== null);
    const tasks = [...v.tasks, ...v.projects.flatMap((p) => p.tasks)];
    const own = countTasks(tasks, states);
    const counts = inner.reduce<Counts>((sum, p) => ({ left: sum.left + p.plate.counts.left, done: sum.done + p.plate.counts.done }), own);
    const has = new Set<Flag>();
    if (v.blocked) has.add("blocked");
    if (tasks.some((t) => overdue.has(t.id))) has.add("overdue");
    if (v.atRisk || v.projects.some((p) => p.atRisk)) has.add("at risk");
    for (const c of inner) for (const f of c.all) has.add(f);
    return {
      all: has,
      plate: {
        id, name: v.name, icon: v.icon, letters: letters.get(id) ?? "",
        stage: v.stageId === null ? null : stages.get(v.stageId) ?? null,
        flags: flagsOf(has).slice(0, PLATE_FLAGS),
        counts, projects: rows, inner: inner.map((c) => c.plate),
      },
    };
  };

  const seen = new Set<string>();
  return roots.map((r) => build(r, seen)).filter((p) => p !== null).map((p) => p.plate);
}
