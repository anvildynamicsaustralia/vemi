/**
 * The finish and reopen move (VEMI-013): a tick moves a task into its space's first finished
 * state, and a tick on a finished task moves it back to the first not-started one. Today and a
 * project's milestones both come through here, so a tick means one thing everywhere.
 *
 * Pure: the sending is handed in, so the move can be proved without a Worker.
 */
import type { StateKind } from "@vemi/shared";
import type { Outcome } from "./outcome.js";
import type { Step } from "./undo.js";

/** The space a task is in, as far as a tick needs to know it. */
export interface TickVenture {
  readonly name: string;
  readonly states: readonly {
    readonly id: string;
    readonly kind: StateKind;
    readonly position: number;
    readonly createdAt: string;
  }[];
}

export interface TickSend {
  readonly act: (work: () => Promise<unknown>, step: Step) => Promise<Outcome | boolean>;
  readonly update: (kind: "tasks", id: string, fields: { readonly stateId: string | null }) => Promise<unknown>;
  readonly archive: (kind: "tasks", id: string) => Promise<unknown>;
  readonly notify: (message: string) => void;
}

/**
 * Tick the task: finish it, or reopen it when `done`. Answers what became of the write, or
 * null when the space has no state to move it into, which is said and nothing is sent.
 */
export function tickTask(
  send: TickSend,
  task: { readonly id: string; readonly title: string; readonly stateId: string | null },
  venture: TickVenture,
  done: boolean,
): Promise<Outcome | boolean> | null {
  const want: StateKind = done ? "not_started" : "finished";
  const target = [...venture.states]
    .sort((a, b) => a.position - b.position || a.createdAt.localeCompare(b.createdAt))
    .find((s) => s.kind === want);
  if (target === undefined) {
    send.notify(`${venture.name} has no ${done ? "not-started" : "finished"} state to move this into.`);
    return null;
  }
  const was = task.stateId;
  // The next task the Worker made when this finished a repeating one, so undo can set it aside.
  let spawned: string | null = null;
  const move = async (): Promise<unknown> => {
    const answer = await send.update("tasks", task.id, { stateId: target.id });
    spawned = spawnedId(answer);
    return answer;
  };
  return send.act(move, {
    what: done ? `reopened ${task.title}` : `finished ${task.title}`,
    undo: async () => {
      const answer = await send.update("tasks", task.id, { stateId: was });
      const next = spawned;
      spawned = null;
      if (next !== null) await send.archive("tasks", next);
      return answer;
    },
    redo: move,
  });
}

/** The id of the task an update answer says it spawned, or null when it spawned none or was only queued. */
function spawnedId(answer: unknown): string | null {
  if (typeof answer !== "object" || answer === null || !("spawned" in answer)) return null;
  const next = (answer as { readonly spawned?: { readonly id?: unknown } | null }).spawned;
  return typeof next?.id === "string" ? next.id : null;
}
