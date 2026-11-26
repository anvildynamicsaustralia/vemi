/**
 * The minute's check for reminders, in the page. There is no push service to call a closed
 * copy: while VEMI is open and in view the check runs every minute, and the moment the page
 * becomes visible again, so a reminder that came due while the tab was hidden shows when it is
 * seen. While the page is hidden nothing runs and nothing is shown to nobody; what the page
 * hid for is handed to the next check, which lets go of a reminder older than its window.
 *
 * What is due is decided by `localTick`, next to the database. This asks it through the
 * bridge and shows what it answers with `showReminder`.
 */
import { TICK_PATH } from "../../local/tickPath.js";
import type { Reminder } from "../reminderEvent.js";

export const TICK_EVERY_MS = 60_000;

/** The slice of `document` this reads. */
export interface Visibility {
  readonly visibilityState: DocumentVisibilityState;
  addEventListener(type: "visibilitychange", listener: () => void): void;
  removeEventListener(type: "visibilitychange", listener: () => void): void;
}

export interface TickerOptions {
  /** Asks what is due. `hiddenSince` is when the page went out of view, if it was out of view. */
  readonly run: (hiddenSince: Date | null) => Promise<readonly Reminder[]>;
  /** `showReminder`. */
  readonly show: (reminder: Reminder) => void;
  readonly page: Visibility;
  readonly now?: () => Date;
  readonly setTimer?: (fn: () => void, ms: number) => unknown;
  readonly clearTimer?: (handle: unknown) => void;
}

/** Starts the check. Answers the way to stop it. */
export function startTicker(options: TickerOptions): () => void {
  const now = options.now ?? (() => new Date());
  const setTimer = options.setTimer ?? ((fn, ms) => globalThis.setInterval(fn, ms));
  const clearTimer = options.clearTimer ?? ((handle) => globalThis.clearInterval(handle as number));
  let hiddenSince: Date | null = options.page.visibilityState === "hidden" ? now() : null;
  let running = false;
  let stopped = false;

  const check = async (): Promise<void> => {
    if (stopped || running || options.page.visibilityState === "hidden") return;
    running = true;
    const since = hiddenSince;
    hiddenSince = null;
    try {
      for (const reminder of await options.run(since)) options.show(reminder);
    } catch {
      // The database is busy or this tab is between owners; the next minute asks again.
      if (since !== null && hiddenSince === null) hiddenSince = since;
    } finally {
      running = false;
    }
  };

  const onVisibility = (): void => {
    if (options.page.visibilityState === "hidden") hiddenSince ??= now();
    else void check();
  };

  options.page.addEventListener("visibilitychange", onVisibility);
  const timer = setTimer(() => void check(), TICK_EVERY_MS);
  void check();
  return () => {
    stopped = true;
    clearTimer(timer);
    options.page.removeEventListener("visibilitychange", onVisibility);
  };
}

/** `run` for the real page: through the bridge's `fetch`, to the database. */
export function askForDue(doFetch: typeof fetch = (input, init) => fetch(input, init)): TickerOptions["run"] {
  return async (hiddenSince) => {
    const response = await doFetch(TICK_PATH, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(hiddenSince === null ? {} : { hiddenSince: hiddenSince.toISOString() }),
    });
    if (!response.ok) throw new Error("The check did not answer.");
    return ((await response.json()) as { due: Reminder[] }).due;
  };
}
