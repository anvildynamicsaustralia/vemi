/**
 * Drives an update from the browser: `start` once, then `step` until the answer says done, one
 * request at a time, repeating a step while it has work left. It holds no key and no secret; it
 * only keeps the step it is at so a closed tab can pick the run up again. A failure stops the
 * drive with the Worker's own sentence and the step that stopped, and driving again resumes there.
 */
import { UPDATE_STEPS, type UpdateApi, type UpdateStep, type UpdateTap } from "./updateApi.js";

/** The words the list uses for each step. */
export const STEP_WORDS: Readonly<Record<UpdateStep, string>> = {
  start: "Restore point",
  files: "App files",
  data: "Data layout",
  app: "New version",
};

export type RowState = "waiting" | "active" | "done" | "failed";

export interface RunRow {
  readonly step: UpdateStep;
  readonly label: string;
  readonly state: RowState;
}

/** Where a drive stands: the step it is at, whether it finished, and the sentence it stopped with. */
export interface RunState {
  readonly at: UpdateStep;
  readonly done: boolean;
  readonly error: string | null;
}

/** The list, in plain words, for a state. Steps before `at` are ticked; `at` is working, failed or, when done, ticked. */
export function rowsOf(run: RunState): readonly RunRow[] {
  const at = UPDATE_STEPS.indexOf(run.at);
  return UPDATE_STEPS.map((step, i): RunRow => {
    const state: RowState = run.done || i < at ? "done" : i > at ? "waiting" : run.error !== null ? "failed" : "active";
    return { step, label: STEP_WORDS[step], state };
  });
}

export interface DriveOptions {
  /** Told every time the state changes. */
  readonly on: (run: RunState) => void;
  /** Told the step to resume from, or null once the run is over. */
  readonly keep: (step: UpdateStep | null) => void;
  /** Waits when the Worker answered the same thing twice (another tab holds the step). */
  readonly sleep?: (ms: number) => Promise<void>;
}

const wait = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms); });

/** The step after one that has finished. */
const after = (step: UpdateStep): UpdateStep => UPDATE_STEPS[Math.min(UPDATE_STEPS.indexOf(step) + 1, UPDATE_STEPS.length - 1)]!;

/** Runs from `from` to the end or to the first failure, and answers where it stopped. */
export async function driveUpdate(api: UpdateApi, from: UpdateStep, options: DriveOptions): Promise<RunState> {
  const sleep = options.sleep ?? wait;
  let at = from;
  const show = (done: boolean, error: string | null): RunState => {
    const state = { at, done, error };
    options.on(state);
    return state;
  };
  try {
    if (at === "start") {
      show(false, null);
      const first = await api.start();
      if (first.done) {
        options.keep(null);
        return show(true, null);
      }
      at = "files";
      options.keep(at);
    }
    let last: UpdateTap | null = null;
    for (;;) {
      show(false, null);
      const tap = await api.step();
      if (tap.done) {
        options.keep(null);
        return show(true, null);
      }
      // A step with nothing left is finished; one with work left runs again.
      at = tap.remaining === 0 ? after(tap.step) : tap.step;
      options.keep(at);
      if (last !== null && last.step === tap.step && last.remaining === tap.remaining) await sleep(1000);
      last = tap;
    }
  } catch (error) {
    const said = error instanceof Error ? error.message : "Something went wrong during the update.";
    const stopped = (error as { step?: UpdateStep | null }).step;
    if (stopped !== null && stopped !== undefined) at = stopped;
    options.keep(at);
    return show(false, said);
  }
}

const KEY = "vemi.update.run";

/** The step a closed tab left off at, for the version being installed; null when there is none. */
export function keptStep(version: string, storage: Pick<Storage, "getItem"> | null = safe()): UpdateStep | null {
  try {
    const raw = storage?.getItem(KEY);
    if (raw === null || raw === undefined) return null;
    const kept = JSON.parse(raw) as { version?: unknown; step?: unknown };
    if (kept.version !== version) return null;
    return (UPDATE_STEPS as readonly unknown[]).includes(kept.step) ? (kept.step as UpdateStep) : null;
  } catch {
    return null;
  }
}

/** Remembers the step, or forgets the run when `step` is null. Never throws: a blocked store only loses the resume. */
export function keepStep(version: string, step: UpdateStep | null, storage: Pick<Storage, "setItem" | "removeItem"> | null = safe()): void {
  try {
    if (step === null) storage?.removeItem(KEY);
    else storage?.setItem(KEY, JSON.stringify({ version, step }));
  } catch {
    // Nothing to do: the run itself is kept by the Worker.
  }
}

function safe(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}
