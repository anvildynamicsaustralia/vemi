/**
 * What an app did on a person's behalf, kept for 7 days so the person can take it back.
 *
 * Every connector write leaves one row with the client's name and the record's earlier
 * values. Undo puts those values back; an added record is archived, never deleted. It is
 * refused, with a plain line, when it was undone already, is older than 7 days, or the
 * record has been changed since by anyone else, because putting the old values back would
 * then throw that newer work away.
 */
import type { Change, Kind } from "@vemi/shared";
import type { ChangeNote } from "./connectorTools.js";
import type { ConnectorChange, Outcome, Store } from "./store.js";
import { parsePatch } from "./validate.js";

export const KEPT_DAYS = 7;
const DAY = 24 * 60 * 60 * 1000;

/** The fields a connector write can change, which is all an undo has to put back. */
const RESTORABLE: Partial<Record<Kind, readonly string[]>> = {
  tasks: ["title", "dueOn", "remindAt", "repeat", "projectId", "milestoneId", "stateId", "pickedOn"],
  projects: ["description", "whoFor", "doneLooks", "openQuestions"],
};

/** What the person's screens are told. The earlier values stay on the server. */
export interface ChangeView {
  readonly id: string;
  readonly clientName: string;
  readonly tool: string;
  readonly kind: Kind;
  readonly recordId: string;
  readonly createdAt: string;
  readonly undoneAt: string | null;
}

export interface Changes {
  /** The `record` a tool call is given: it keeps each write against the grant it came in on. */
  recorder(grant: { readonly id: string; readonly clientName: string }): NonNullable<import("./connectorTools.js").ToolDeps["record"]>;
  /** The last 7 days, newest first. */
  list(owner: string): Promise<ChangeView[]>;
  undo(owner: string, id: string): Promise<Outcome<ChangeView>>;
}

export interface ChangesDeps {
  readonly store: Store;
  readonly now: () => Date;
  readonly publish: (owner: string, change: Change) => void | Promise<void>;
}

const view = (c: ConnectorChange): ChangeView => ({
  id: c.id, clientName: c.clientName, tool: c.tool, kind: c.kind, recordId: c.recordId, createdAt: c.createdAt, undoneAt: c.undoneAt,
});

const refuse = (status: 400 | 404 | 409, error: string): Outcome<never> => ({ ok: false, status, error });

function earlier(kind: Kind, record: unknown): Record<string, unknown> | null {
  const fields = RESTORABLE[kind];
  if (fields === undefined || typeof record !== "object" || record === null) return null;
  const from = record as Record<string, unknown>;
  return Object.fromEntries(fields.map((f) => [f, from[f] ?? null]));
}

export function createChanges(deps: ChangesDeps): Changes {
  const { store } = deps;
  const since = (): string => new Date(deps.now().getTime() - KEPT_DAYS * DAY).toISOString();

  function recorder(grant: { readonly id: string; readonly clientName: string }) {
    return async (owner: string, note: ChangeNote): Promise<void> => {
      await store.recordChange(owner, {
        grantId: grant.id, clientName: grant.clientName, tool: note.tool, kind: note.kind, recordId: note.recordId,
        before: note.before === null ? null : earlier(note.kind, note.before),
      });
    };
  }

  async function list(owner: string): Promise<ChangeView[]> {
    return (await store.changes(owner, since())).map(view);
  }

  async function undo(owner: string, id: string): Promise<Outcome<ChangeView>> {
    const change = await store.change(owner, id);
    if (change === null) return refuse(404, "that change was not found");
    if (change.undoneAt !== null) return refuse(409, "that change was already undone");
    if (change.createdAt < since()) return refuse(409, "that change is more than 7 days old");

    const record = await store.get(owner, change.kind, change.recordId);
    if (record === null) return refuse(404, "that record was not found");

    // Anything done to the record since this change: by the app again (then that one is undone
    // first), or by the person (then it is theirs to keep).
    const others = (await store.changes(owner, change.createdAt)).filter((c) => c.recordId === change.recordId && c.id !== change.id);
    if (others.some((c) => c.undoneAt === null && c.createdAt > change.createdAt)) {
      return refuse(409, "undo the later change to it first");
    }
    const ours = [change.createdAt, ...others.flatMap((c) => (c.undoneAt === null ? [c.createdAt] : [c.createdAt, c.undoneAt]))];
    if (record.updatedAt > ours.reduce((a, b) => (a > b ? a : b))) {
      return refuse(409, "that was changed since, so it was left as it is");
    }

    const today = deps.now().toISOString().slice(0, 10);
    let written;
    if (change.before === null) {
      written = await store.setArchived(owner, change.kind, change.recordId, true);
    } else {
      const patch = parsePatch(change.kind, change.before as Record<string, unknown>);
      if (!patch.ok) return refuse(400, patch.error);
      written = await store.update(owner, change.kind, change.recordId, patch.value, today);
    }
    if (!written.ok) return written;
    if (!(await store.markChangeUndone(owner, change.id))) return refuse(409, "that change was already undone");
    await deps.publish(owner, { kind: change.kind, id: change.recordId, ventureId: written.value.ventureId });
    return { ok: true, value: { ...view(change), undoneAt: deps.now().toISOString() } };
  }

  return { recorder, list, undo };
}
