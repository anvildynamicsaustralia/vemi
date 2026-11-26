/**
 * What a push message becomes on this device. The pure mapping lives here so it can be
 * tested; `sw.js` cannot import, so it carries a twin of `notificationFor`, `openUrlFor`,
 * `inAppFor`, `actBody` and `shownPayload` (and, for a sealed title, the code that finds the
 * device key in IndexedDB and opens it, which only `sw.js` has; change both; `pushMessage.test.ts` runs the worker to check
 * they agree).
 *
 * A reminder for a task, with a VEMI tab on screen, is drawn by the in-app banner and the
 * worker shows no system notification. Every other message is shown by the system.
 */
import type { PushPayload } from "@vemi/shared";
import type { Reminder } from "./reminderEvent.js";

export type ReminderAction = "done" | "snooze";

export interface NotificationData {
  readonly kind: PushPayload["kind"];
  /** Where a tap goes. */
  readonly url: string;
  readonly taskId?: string;
  readonly at?: string;
}

export interface NotificationPlan {
  readonly title: string;
  readonly options: {
    readonly body: string;
    readonly tag: string;
    readonly data: NotificationData;
    readonly actions: readonly { readonly action: ReminderAction; readonly title: string }[];
  };
}

/** The message the worker posts to a visible tab. */
export const PUSH_MESSAGE = "vemi-push";
/** The message the worker posts to an open tab it focused, to take it to a page. */
export const OPEN_MESSAGE = "vemi-open";

/** A tap on a task opens it over whatever is showing; every other message opens Today. */
export function openUrlFor(payload: PushPayload): string {
  if (payload.kind === "task" && payload.taskId !== undefined) return `/?task=${encodeURIComponent(payload.taskId)}`;
  return "/today";
}

/** The reminder the banner draws, or null when this message is not one it can draw. */
export function inAppFor(payload: PushPayload): Reminder | null {
  if (payload.kind !== "task" || payload.taskId === undefined || payload.at === undefined) return null;
  return { taskId: payload.taskId, at: payload.at };
}

/** The system notification for a payload. `maxActions` is `Notification.maxActions`. */
export function notificationFor(payload: PushPayload, maxActions: number): NotificationPlan {
  const reminder = inAppFor(payload);
  const all = reminder === null ? [] : [
    { action: "done" as const, title: "Done" },
    { action: "snooze" as const, title: "In 1 hour" },
  ];
  return {
    title: payload.title,
    options: {
      body: payload.body,
      tag: payload.tag,
      data: {
        kind: payload.kind,
        url: openUrlFor(payload),
        ...(payload.taskId !== undefined ? { taskId: payload.taskId } : {}),
        ...(payload.at !== undefined ? { at: payload.at } : {}),
      },
      actions: all.slice(0, Math.max(0, Math.floor(maxActions))),
    },
  };
}

/**
 * The payload to show once this device has tried to open `sealedTitle` (`title`: the opened
 * text, or null when there is no key here or the envelope would not open). The twin of
 * `shownFor` in `sw.js`. A task reminder takes the title; a count message (held, morning)
 * takes it as its body. With none, the server's own words stand: the generic title, or the
 * count line only. The envelope itself is never shown.
 */
export function shownPayload(payload: PushPayload, title: string | null): PushPayload {
  const { sealedTitle: _sealed, ...rest } = payload;
  if (title === null) return rest;
  return payload.kind === "task" ? { ...rest, title } : { ...rest, body: title };
}

/** The body for `POST /api/push/act`, or null when the notification cannot act. */
export function actBody(data: NotificationData, action: string): { taskId: string; action: ReminderAction; at: string } | null {
  if (action !== "done" && action !== "snooze") return null;
  if (data.taskId === undefined || data.at === undefined) return null;
  return { taskId: data.taskId, action, at: data.at };
}

interface Messages {
  addEventListener(type: "message", listener: (event: MessageEvent) => void): void;
  removeEventListener(type: "message", listener: (event: MessageEvent) => void): void;
}

/**
 * Listens for what the worker posts. A pushed reminder goes to `show`; a tap on a
 * notification, when this tab was the one focused, goes to `open` with the path.
 * Answers the way to stop listening.
 */
export function listenForPush(
  from: Messages,
  handlers: { readonly show: (reminder: Reminder) => void; readonly open: (url: string) => void },
): () => void {
  const listener = (event: MessageEvent): void => {
    const data: unknown = event.data;
    if (typeof data !== "object" || data === null) return;
    const m = data as { type?: unknown; payload?: unknown; url?: unknown };
    if (m.type === PUSH_MESSAGE && typeof m.payload === "object" && m.payload !== null) {
      const reminder = inAppFor(m.payload as PushPayload);
      if (reminder !== null) handlers.show(reminder);
    } else if (m.type === OPEN_MESSAGE && typeof m.url === "string" && m.url.startsWith("/")) {
      handlers.open(m.url);
    }
  };
  from.addEventListener("message", listener);
  return () => from.removeEventListener("message", listener);
}
