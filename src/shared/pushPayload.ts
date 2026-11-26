/**
 * The one shape a push message carries, from the Worker that sends it to the service worker
 * that shows it. Defined once here so both sides agree. `title` and `body` stay separate
 * fields; for an account with full encryption the real task title rides in `sealedTitle`,
 * the task's own title envelope, and only a device that holds the key can open it.
 */
import { envelopeLimit, isEnvelopeShape } from "./encryptedFields.js";
import { TASK_TITLE_MAX } from "./limits.js";

export const PUSH_KINDS = ["task", "morning", "held", "test"] as const;
export type PushKind = (typeof PUSH_KINDS)[number];

export interface PushPayload {
  readonly kind: PushKind;
  readonly title: string;
  readonly body: string;
  /** The task a `task` message is about. */
  readonly taskId?: string;
  /** The local wall time (`YYYY-MM-DDTHH:MM`) the reminder was set for. */
  readonly at?: string;
  /** How many reminders a `morning` or `held` message stands for. */
  readonly count?: number;
  /**
   * The title envelope of the task named by `taskId` (for a `held` or `morning` message, of
   * the first task), bound `{record: taskId, field: "title"}`. Never plain text.
   */
  readonly sealedTitle?: string;
  /** Messages with the same tag replace one another on the device. */
  readonly tag: string;
}

export type PushPayloadResult = { readonly ok: true; readonly value: PushPayload } | { readonly ok: false; readonly error: string };

const KEYS = new Set(["kind", "title", "body", "taskId", "at", "count", "tag", "sealedTitle"]);

const fail = (error: string): PushPayloadResult => ({ ok: false, error });

/** Checks an unknown value is a push payload, and copies out only the known keys. */
export function parsePushPayload(v: unknown): PushPayloadResult {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return fail("a push payload is an object");
  const o = v as Record<string, unknown>;
  for (const key of Object.keys(o)) if (!KEYS.has(key)) return fail(`a push payload has no ${key}`);
  if (typeof o.kind !== "string" || !(PUSH_KINDS as readonly string[]).includes(o.kind)) return fail("kind is not one of task, morning, held, test");
  if (typeof o.title !== "string") return fail("title is text");
  if (typeof o.body !== "string") return fail("body is text");
  if (typeof o.tag !== "string" || o.tag === "") return fail("tag is text and not empty");
  if (o.taskId !== undefined && (typeof o.taskId !== "string" || o.taskId === "")) return fail("taskId is text and not empty");
  if (o.at !== undefined && (typeof o.at !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(o.at))) return fail("at is YYYY-MM-DDTHH:MM");
  if (o.count !== undefined && (typeof o.count !== "number" || !Number.isInteger(o.count) || o.count < 0)) return fail("count is a whole number");
  if (o.sealedTitle !== undefined) {
    if (typeof o.sealedTitle !== "string" || !isEnvelopeShape(o.sealedTitle)) return fail("sealedTitle is a sealed title");
    if (o.sealedTitle.length > envelopeLimit(TASK_TITLE_MAX)) return fail("sealedTitle is too long");
    if (o.taskId === undefined) return fail("a sealed title names its task");
  }
  if (o.kind === "task" && o.taskId === undefined) return fail("a task message names its task");
  return {
    ok: true,
    value: {
      kind: o.kind as PushKind,
      title: o.title,
      body: o.body,
      tag: o.tag,
      ...(o.taskId !== undefined ? { taskId: o.taskId as string } : {}),
      ...(o.at !== undefined ? { at: o.at as string } : {}),
      ...(o.count !== undefined ? { count: o.count as number } : {}),
      ...(o.sealedTitle !== undefined ? { sealedTitle: o.sealedTitle as string } : {}),
    },
  };
}
