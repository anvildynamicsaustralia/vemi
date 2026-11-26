/**
 * The one way a task is made (VEMI-009). The Add surface, a board column and a project row
 * all come through here, so there is one shape of request and one code path that sends it.
 *
 * **A pre-fill is a value, not a mode.** A column that pre-fills its state hands over the same
 * object the Add surface builds when a person picks that state by hand. What was pre-filled
 * stays changeable, and nothing here asks for more than the rule does: a task needs a title
 * and a venture, and nothing else, ever.
 *
 * Pure: the sending is handed in, so what gets sent can be proved without a Worker.
 */
import { TASK_TITLE_MAX, type Priority } from "@vemi/shared";
import type { Grouping } from "./boardGroups.js";
import type { Outcome } from "./outcome.js";
import type { Route } from "./router.js";
import { worthSendingAgain } from "./sendAgain.js";
import type { Step } from "./undo.js";

/** Where a new task starts, before anyone has typed. Every field optional. */
export interface Prefill {
  readonly ventureId?: string | null;
  readonly stateId?: string | null;
  readonly projectId?: string | null;
  readonly priority?: Priority | null;
  readonly tagIds?: readonly string[];
}

/** Everything a person can pick for a new task besides its title and its venture. */
export interface Picked extends Prefill {
  readonly dueOn?: string | null;
  readonly pickedOn?: string | null;
  /** A milestone of the project: a project page adds a task straight into one. */
  readonly milestoneId?: string | null;
  /** Local wall time, `YYYY-MM-DDTHH:MM`. */
  readonly remindAt?: string | null;
  /** A repeat rule as stored: `day`, `weekday`, `month` or `week:N`. */
  readonly repeat?: string | null;
  /** Text for the task's notes, such as a shared link. */
  readonly body?: string | null;
}

/**
 * What the Today add box saves: the task is picked for today, unless the title named a day,
 * in which case it is due that day and not picked. A repeat or a time alone leaves it picked.
 */
export function todayPicked(
  ventureId: string,
  on: string,
  read: { readonly dueOn: string | null; readonly repeat: string | null; readonly remindAt: string | null },
): Picked {
  return { ventureId, pickedOn: read.dueOn === null ? on : null, dueOn: read.dueOn, repeat: read.repeat, remindAt: read.remindAt };
}

/** The venture the task goes in, as far as a request needs to know it. */
export interface Home {
  readonly id: string;
  readonly states: readonly { readonly id: string }[];
  readonly projects: readonly { readonly id: string }[];
  /** The milestones a task may be put on. Left out, none is: a milestone is only sent when it is known. */
  readonly milestones?: readonly { readonly id: string }[];
}

/**
 * What is sent. A field nobody picked is left out, so the Worker's own default holds. A type
 * rather than an interface, so it is the plain record `api.create` takes.
 */
export type TaskRequest = {
  readonly ventureId: string;
  readonly title: string;
  readonly stateId?: string;
  readonly projectId?: string;
  readonly milestoneId?: string;
  readonly priority?: Priority;
  readonly tagIds?: readonly string[];
  readonly dueOn?: string;
  readonly pickedOn?: string;
  readonly remindAt?: string;
  readonly repeat?: string;
  readonly body?: string;
};

/**
 * The request for a title and what was picked, or null when there is no task to make: a
 * title that is only whitespace, or no venture. A state or project that is not the venture's
 * is dropped rather than sent, which is what a venture changed after the pre-fill means.
 */
export function taskRequest(title: string, venture: Home | null, picked: Picked): TaskRequest | null {
  const text = title.trim();
  if (text === "" || venture === null) return null;
  const { stateId, projectId, milestoneId, priority, tagIds, dueOn, pickedOn, remindAt, repeat, body } = picked;
  return {
    ventureId: venture.id,
    title: text,
    ...(stateId && venture.states.some((s) => s.id === stateId) ? { stateId } : {}),
    ...(projectId && venture.projects.some((p) => p.id === projectId) ? { projectId } : {}),
    ...(milestoneId && venture.milestones?.some((m) => m.id === milestoneId) ? { milestoneId } : {}),
    ...(priority ? { priority } : {}),
    ...(tagIds !== undefined && tagIds.length > 0 ? { tagIds: [...new Set(tagIds)] } : {}),
    ...(dueOn ? { dueOn } : {}),
    ...(pickedOn ? { pickedOn } : {}),
    ...(remindAt ? { remindAt } : {}),
    ...(repeat ? { repeat } : {}),
    ...(body ? { body } : {}),
  };
}

/**
 * Make the task, if there is one to make. `act` is the app's, so a failure is said the way
 * every other write's is; `create` is the Worker's. Answers what became of it, as `act`
 * does, and `false` when there was no task to make.
 *
 * The task's id is named here, once, outside the work `act` may run again: a Try again
 * after a failure the Worker had already written sends the same id, and the Worker answers
 * that repeat with the one task. A caller that may send the same draft twice — Add, pressed
 * again after a failure — hands in the id it named for that draft.
 */
export async function makeTask(
  send: {
    readonly act: (work: () => Promise<unknown>) => Promise<Outcome | boolean>;
    readonly create: (kind: "tasks", input: TaskRequest & { readonly id: string }) => Promise<unknown>;
  },
  title: string,
  venture: Home | null,
  picked: Picked,
  id: string = crypto.randomUUID(),
): Promise<Outcome | boolean> {
  const request = taskRequest(title, venture, picked);
  if (request === null) return false;
  const named = { ...request, id };
  return send.act(() => send.create("tasks", named));
}

/**
 * Make a task for each title, in order, as one step: a list pasted into an add line. Each is
 * made the one way `makeTask` makes one, and each names its own id up front, so the step
 * that takes them back archives exactly these and the step forward brings exactly these
 * back. Nothing is deleted. Answers how many were made; none when there was nothing to make.
 *
 * One after another rather than all at once: a new task goes after every other, so sending
 * them in order is what puts them in the order they were pasted.
 *
 * All or none. A line too long to be a title is said before anything is sent. A refusal
 * partway through archives the tasks this paste already made, as Undo would, so a refused
 * paste leaves nothing behind that no step can take back. A write that went unanswered is
 * offered again by `act`, and the second go sends only the tasks not yet made.
 *
 * Every write's answer is handed back, so `act` can tell a paste this device is only keeping
 * from one the Worker took. A kept paste answers none: `act` has said it is kept, and a
 * caller that would say "Added 3 tasks" says nothing over that.
 */
export async function makeTasks(
  send: {
    readonly act: (work: () => Promise<unknown>, step: Step) => Promise<Outcome | boolean>;
    readonly create: (kind: "tasks", input: TaskRequest & { readonly id: string }) => Promise<unknown>;
    readonly archive: (kind: "tasks", id: string) => Promise<unknown>;
    readonly unarchive: (kind: "tasks", id: string) => Promise<unknown>;
    readonly newId: () => string;
    readonly say: (message: string) => void;
  },
  titles: readonly string[],
  venture: Home | null,
  picked: Picked,
): Promise<number> {
  const long = titles.findIndex((title) => title.trim().length > TASK_TITLE_MAX);
  if (long >= 0) {
    send.say(`Line ${long + 1} is longer than ${TASK_TITLE_MAX} characters, so no tasks were added.`);
    return 0;
  }
  const requests = titles.flatMap((title) => {
    const request = taskRequest(title, venture, picked);
    return request === null ? [] : [{ ...request, id: send.newId() }];
  });
  if (requests.length === 0) return 0;
  const each = async (run: (id: string) => Promise<unknown>): Promise<unknown[]> => {
    const answers: unknown[] = [];
    for (const r of requests) answers.push(await run(r.id));
    return answers;
  };
  const sent = new Map<string, unknown>();
  const made = await send.act(async () => {
    try {
      for (const r of requests) {
        if (sent.has(r.id)) continue;
        sent.set(r.id, await send.create("tasks", r));
      }
      return [...sent.values()];
    } catch (err) {
      if (!worthSendingAgain(err)) {
        for (const id of sent.keys()) await send.archive("tasks", id);
      }
      throw err;
    }
  }, {
    what: `added ${requests.length} tasks`,
    undo: () => each((id) => send.archive("tasks", id)),
    redo: () => each((id) => send.unarchive("tasks", id)),
  });
  return made === "sent" || made === true ? requests.length : 0;
}

/**
 * One typed line, made as `makeTasks` makes it. Answers whether the line should empty: it did
 * when the Worker took the task, and also when this device kept it to send later, because a
 * line left full after a kept task reads as if nothing happened and a second Enter would queue a copy.
 */
export async function addLine(
  send: Parameters<typeof makeTasks>[0],
  title: string,
  venture: Home | null,
  picked: Picked,
): Promise<boolean> {
  let kept = false;
  const made = await makeTasks({
    ...send,
    act: async (work, step) => {
      const outcome = await send.act(work, step);
      if (outcome === "kept") kept = true;
      return outcome;
    },
  }, [title], venture, picked);
  return made > 0 || kept;
}

/**
 * What a board column pre-fills: its own grouping's field. A none-column pre-fills nothing,
 * because having no project is what "No project" means, and inventing one would be a lie
 * about where the task went.
 */
export function columnPrefill(grouping: Grouping, key: string): Prefill {
  if (key === "") return {};
  switch (grouping) {
    case "state": return { stateId: key };
    case "project": return { projectId: key };
  }
}

/**
 * What Add starts with when it is opened from where a person is. N, the rail's Add and the
 * phone's + all come through here, so every way in pre-fills the same. A project's page puts
 * the task in that project, as its own ⋯ does. Today puts it on today, as Today's
 * copy promises. Anywhere else inside a venture, that venture; outside one, nothing.
 */
export function prefillFrom(route: Route): Prefill & { readonly onToday?: true } {
  if (route.surface === "today") return { onToday: true };
  if (route.ventureId === null) return {};
  if (route.surface === "project" && route.itemId !== null) return { ventureId: route.ventureId, projectId: route.itemId };
  return { ventureId: route.ventureId };
}

/** The notice a made task earns: where it went, by the most particular name there is. */
export const addedTo = (ventureName: string, projectName: string | null): string =>
  `Added to ${projectName ?? ventureName}`;

/**
 * Whether Add offers the Tags group. Add is a title and a few labelled groups, and every tag
 * there is would be an unbounded one more, so it is offered only when a tag was pre-filled —
 * a pre-fill that carries one — where it has to stay changeable before the task is
 * made. A new tag is made on the task, never here.
 */
export const offersTags = (prefill: Prefill): boolean => prefill.tagIds !== undefined && prefill.tagIds.length > 0;
