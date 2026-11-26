/**
 * A task moved into another venture, and the way back.
 *
 * The Worker does more than the one field says: in another venture the task has no project
 * and no milestone, and it lands in that venture's first state of the kind it was in. So
 * the way back cannot be the venture alone. It names all four as the task has them before
 * the move, and the Worker accepts them because each one belongs to the venture it names.
 *
 * Forward sends the venture only, so the Worker finds the new state itself, the same way
 * every time it is redone.
 *
 * Pure, so the shape of both can be proved without a Worker.
 */
import type { Task } from "@vemi/shared";

type Placing = Pick<Task, "ventureId" | "projectId" | "milestoneId" | "stateId">;

export function ventureMove(task: Placing, ventureId: string): {
  readonly forward: { readonly ventureId: string };
  readonly back: Placing;
} {
  return {
    forward: { ventureId },
    back: { ventureId: task.ventureId, projectId: task.projectId, milestoneId: task.milestoneId, stateId: task.stateId },
  };
}
