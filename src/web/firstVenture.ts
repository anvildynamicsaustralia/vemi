/**
 * When a new account is asked for its first venture, and when that venture is ready to open.
 *
 * Kept apart from the shell because the two answers are easy to get wrong in ways a screen hides:
 * an archived venture is still a venture, so an account that archived everything is not new, and
 * the overview and the tree load on their own paths, so the tree can lag the overview.
 */
import type { Overview, Today, Tree } from "@vemi/shared";
import type { FirstRunStep } from "./firstRunSteps.js";

/** Null until the overview arrives, so the shell draws nothing rather than the wrong screen. */
export function isFirstRun(overview: Overview | null): boolean | null {
  if (overview === null) return null;
  return overview.ventures.length === 0 && overview.archivedVentures === 0;
}

/** True only once the tree holds the venture; opening it sooner would bounce to home. */
export function opened(tree: Tree | null, id: string): boolean {
  return tree !== null && tree.ventures.some((venture) => venture.id === id);
}

/**
 * What the card does now. `open`: the tree holds the venture this card asked for. `leave`: the
 * account has a venture from somewhere else (another tab or device, a kept write from an earlier
 * session, or one archived meanwhile), so it is no longer new and the card goes without opening
 * anything. `wait`: neither yet.
 */
export function cardOutcome(tree: Tree | null, overview: Overview | null, id: string): "open" | "leave" | "wait" {
  if (opened(tree, id)) return "open";
  const others = (tree?.ventures.length ?? 0) > 0 || (overview?.archivedVentures ?? 0) > 0;
  return others ? "leave" : "wait";
}

/** Where first run stands against what the account already holds. */
export interface FirstRunProgress {
  /** The step to be on: the stored one, or the first later step whose thing does not exist yet. */
  readonly step: FirstRunStep;
  /** The first space, once there is one. */
  readonly ventureId: string | null;
  /** The first project in that space, once there is one. */
  readonly projectId: string | null;
  /** The first task in that project, once there is one. */
  readonly taskId: string | null;
}

/**
 * Steps 2 to 5 each make one thing. A thing that already exists (made before the step was saved,
 * or on another device) moves the step on rather than asking again. Steps outside 2 to 5 are
 * left as they are. Step 5 waits for today's answer: with none it does not guess.
 */
export function firstRunProgress(step: FirstRunStep, tree: Tree | null, today: Today | null): FirstRunProgress {
  const space = tree?.ventures[0] ?? null;
  const project = space?.projects[0] ?? null;
  const task = project?.tasks[0] ?? null;
  const base = { ventureId: space?.id ?? null, projectId: project?.id ?? null, taskId: task?.id ?? null };
  if (tree === null || step < 2 || step > 5) return { step, ...base };
  let at: FirstRunStep = step;
  if (at === 2 && space !== null) at = 3;
  if (at === 3 && project !== null) at = 4;
  if (at === 4 && task !== null) at = 5;
  const picked = today !== null && tree.ventures.some((v) => v.projects.some((p) => p.tasks.some((t) => t.pickedOn === today.on)));
  if (at === 5 && picked) at = 6;
  return { step: at, ...base };
}
