import { projectBrief, type BriefFields } from "./projectBrief.js";

/**
 * The Next step on the project page (VEMI-013, project phase, decision 2). In order: the first
 * empty Brief step; no milestone; the selected milestone's first open task; the first open task
 * of any milestone; the first open task with no milestone; else add a task. Pure: the caller says
 * which tasks are done and hands them in the order they are shown.
 */
export interface NextInput {
  readonly brief: BriefFields;
  /** In display order. */
  readonly milestones: readonly { readonly id: string; readonly name: string }[];
  /** In display order. `done` is true for a task in a finished state. */
  readonly tasks: readonly {
    readonly id: string;
    readonly title: string;
    readonly milestoneId: string | null;
    readonly done: boolean;
  }[];
  readonly selectedMilestoneId: string | null;
}

export type NextStep =
  | { readonly kind: "brief"; readonly step: number }
  | { readonly kind: "milestone" }
  | { readonly kind: "task"; readonly taskId: string; readonly milestoneId: string | null }
  | { readonly kind: "addTask"; readonly milestoneId: string | null };

export function projectNext(input: NextInput): NextStep {
  const { firstEmpty } = projectBrief(input.brief);
  if (firstEmpty >= 0) return { kind: "brief", step: firstEmpty };
  if (input.milestones.length === 0) return { kind: "milestone" };

  const open = input.tasks.filter((t) => !t.done);
  const pick = (t: (typeof open)[number]): NextStep => ({
    kind: "task",
    taskId: t.id,
    milestoneId: t.milestoneId,
  });

  const selected = input.milestones.find((m) => m.id === input.selectedMilestoneId);
  if (selected) {
    const t = open.find((x) => x.milestoneId === selected.id);
    if (t) return pick(t);
  }
  for (const m of input.milestones) {
    const t = open.find((x) => x.milestoneId === m.id);
    if (t) return pick(t);
  }
  const loose = open.find((x) => x.milestoneId === null);
  if (loose) return pick(loose);
  return { kind: "addTask", milestoneId: selected?.id ?? null };
}
