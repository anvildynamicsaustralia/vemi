/**
 * The database worker: a module Web Worker that holds the one open database.
 *
 * It loads the wasm from its own origin, keeps the database in the browser's private file
 * system under the directory `vemi-local` (the `opfs-sahpool` VFS), runs the migrations, and
 * answers bridge messages one at a time, in the order they came. Where the browser cannot keep
 * a file (a private window in some browsers, an old browser) it opens an in-memory database and
 * says `volatile`, so the page can say plainly that nothing is being kept.
 *
 * Only the tab that owns the database starts this worker; see `leader.ts`.
 */
import type { WireRequest, WireResponse } from "./bridge.js";
import type { WorkerIn, WorkerOut } from "./workerMessages.js";
import { serve } from "./bridge.js";
import { createChannel } from "./channel.js";
import { openLocalApp } from "./localApp.js";
import { openSqliteEngine } from "./sqliteEngine.js";
import type { SqlEngine } from "./sqlD1.js";
import type { Change } from "@vemi/shared";
import { OPFS_DIRECTORY } from "./opfsDirectory.js";

export type { WorkerIn, WorkerOut };

export { OPFS_DIRECTORY };
export const DATABASE_FILE = "vemi.sqlite3";

export interface WorkerScope {
  postMessage(message: WorkerOut): void;
  onmessage: ((event: { data: WorkerIn }) => void) | null;
}

export interface Storage {
  readonly engine: SqlEngine;
  /** True when nothing is kept past this page. */
  readonly volatile: boolean;
}

export interface DbWorkerDeps {
  readonly openStorage: () => Promise<Storage>;
  readonly origin: string;
  readonly timeZone: string;
  readonly post: (change: Change) => void;
  readonly now?: () => Date;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** The ways opening the database can be done, so the choice between file and memory can be tested. */
export interface StorageDeps {
  readonly openFile: () => Promise<SqlEngine>;
  readonly openMemory: () => Promise<SqlEngine>;
  readonly sleep: (ms: number) => Promise<void>;
}

/**
 * A refusal that means the file exists and another handle still holds it, as opposed to a browser
 * that cannot keep a file at all. Falling back to memory on this one would show an empty copy of a
 * database that is really there, and whatever was added then would be lost on close.
 */
export function fileIsHeld(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const { name, message } = error as { name?: unknown; message?: unknown };
  return name === "NoModificationAllowedError" || (typeof message === "string" && /access handle/i.test(message));
}

export const HELD_SAID = "This device's data is still being released by another tab. Close other VEMI tabs and reload.";

/**
 * The file if the browser will keep one; otherwise memory. A tab that just closed may not have
 * let go of the file yet, so a refusal is tried again for about ten seconds before it counts. A
 * file that stays held is an error, never memory; only a browser that cannot keep a file falls back.
 */
export async function openStorageWith(deps: StorageDeps): Promise<Storage> {
  let held = false;
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      return { engine: await deps.openFile(), volatile: false };
    } catch (error) {
      held = fileIsHeld(error);
      // A browser that cannot keep a file will not start to; only a held one is worth waiting for.
      if (!held && attempt >= 2) break;
      await deps.sleep(Math.min(100 * 2 ** attempt, 2000));
    }
  }
  if (held) throw new Error(HELD_SAID);
  return { engine: await deps.openMemory(), volatile: true };
}

export function openStorage(): Promise<Storage> {
  return openStorageWith({
    openFile: () => openSqliteEngine({ opfs: { directory: OPFS_DIRECTORY, filename: DATABASE_FILE } }),
    openMemory: () => openSqliteEngine(),
    sleep,
  });
}

/** Wires a worker scope to the database. Everything the scope hears is handled in order. */
export function runDbWorker(scope: WorkerScope, deps: DbWorkerDeps): void {
  let answer: ((wire: WireRequest) => Promise<WireResponse>) | null = null;
  let storage: Storage | null = null;
  let tail: Promise<void> = Promise.resolve();

  const open = async (): Promise<void> => {
    try {
      storage = await deps.openStorage();
      const app = await openLocalApp({
        engine: storage.engine,
        origin: deps.origin,
        timeZone: deps.timeZone,
        post: deps.post,
        ...(deps.now === undefined ? {} : { now: deps.now }),
      });
      answer = serve(app.handle);
      scope.postMessage({ type: "ready", volatile: storage.volatile });
    } catch (error) {
      scope.postMessage({ type: "broken", message: error instanceof Error ? error.message : "The database did not open." });
    }
  };

  const request = async (id: number, wire: WireRequest): Promise<void> => {
    if (answer === null) {
      scope.postMessage({ type: "failed", id, message: "The database is not open." });
      return;
    }
    try {
      scope.postMessage({ type: "answer", id, wire: await answer(wire) });
    } catch (error) {
      scope.postMessage({ type: "failed", id, message: error instanceof Error ? error.message : "failed" });
    }
  };

  const close = async (): Promise<void> => {
    answer = null;
    try {
      await storage?.engine.close();
    } finally {
      scope.postMessage({ type: "closed" });
    }
  };

  scope.onmessage = (event) => {
    const message = event.data;
    // Each starts only when the one before has finished.
    tail = tail.then(() => (message.type === "open" ? open() : message.type === "request" ? request(message.id, message.wire) : close()));
  };
}

// Inside a real worker, start. A page or a test that only imports the types does nothing here.
const scope = globalThis as unknown as WorkerScope & { WorkerGlobalScope?: unknown; location: Location };
if (typeof scope.WorkerGlobalScope !== "undefined" && scope instanceof (scope.WorkerGlobalScope as typeof Object)) {
  const channel = createChannel();
  runDbWorker(scope, {
    openStorage,
    origin: scope.location.origin,
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    post: (change) => channel.post(change),
  });
}
