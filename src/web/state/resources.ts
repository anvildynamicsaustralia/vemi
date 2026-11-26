/**
 * Every read the interface shows, fetched once per path and shared.
 *
 * A component asks for a path; while anything is showing it, it is kept, and the live
 * channel refetches everything being shown. There is no cache to invalidate and no patch to
 * get wrong: the Worker's answer is the only copy of the truth.
 */
import { useCallback, useEffect, useSyncExternalStore } from "react";
import { ApiError, read } from "../api.js";
import { sealedEpoch } from "../sealedApi.js";

export interface Resource<T> {
  readonly data: T | null;
  readonly error: string | null;
  /** When the data on screen left the Worker, as an ISO string. */
  readonly receivedAt: string | null;
  /** True when the data came from this device's copy rather than the Worker just now. */
  readonly fromCopy: boolean;
  /** True while a path with nothing to show yet waits for its answer. A refetch over what is
      already on screen leaves it false, so nothing redraws just for the asking. */
  readonly loading: boolean;
  /** True when the last read failed with no answer from the Worker at all: no connection. */
  readonly unreached: boolean;
}

const EMPTY: Resource<never> = { data: null, error: null, receivedAt: null, fromCopy: false, loading: false, unreached: false };

const entries = new Map<string, Resource<unknown>>();
const users = new Map<string, number>();
const inflight = new Map<string, Promise<void>>();
/** Paths asked for again while a load was running: the running answer may predate the ask. */
const again = new Set<string>();
const fetchedAt = new Map<string, number>();
/** Loads begun so far: each load is numbered by its place in that count. */
let begun = 0;
/** For each path, the number of the latest load the Worker itself answered, not a copy. */
const answeredBy = new Map<string, number>();
/**
 * The body each path's data was parsed from. An answer that says the same again keeps the
 * object already on screen, so everything derived from it by identity stays as it was.
 */
const answeredWith = new Map<string, string>();

/** A screen opening within this long of the last answer shows it without asking again. */
export const FRESH_MS = 2_000;
const listeners = new Set<() => void>();
const signedOutListeners = new Set<() => void>();
/**
 * Bumped by every clear. A load that began before a sign-out carried the old session's cookie,
 * so its answer is dropped rather than put back for whoever signs in next.
 */
let generation = 0;

function set(path: string, next: Resource<unknown>): void {
  entries.set(path, next);
  for (const listener of listeners) listener();
}

/** Called when the Worker refuses a read, a write or the outbox for want of a session. */
export function onSignedOut(listener: () => void): () => void {
  signedOutListeners.add(listener);
  return () => signedOutListeners.delete(listener);
}

/** The Worker answered 401: this device's session is over, whatever was asking. */
export function notifySignedOut(): void {
  for (const listener of signedOutListeners) listener();
}

/** Whether a failure was the session ending. When it was, the device is signed out by it. */
export function endedSession(err: unknown): boolean {
  if (!(err instanceof ApiError) || err.status !== 401) return false;
  notifySignedOut();
  return true;
}

export function load(path: string, now: () => Date = () => new Date()): Promise<void> {
  const running = inflight.get(path);
  if (running !== undefined) {
    // Two ticks in quick succession: the load already running began before the second
    // write landed, so its answer could be missing it. Run once more when it finishes.
    again.add(path);
    return running;
  }
  const before = entries.get(path) ?? EMPTY;
  if (before.data === null) set(path, { ...before, loading: true });
  const mine = generation;
  const number = begun;
  begun += 1;
  const work = read<unknown>(path)
    .then((answer) => {
      if (mine !== generation) return;
      fetchedAt.set(path, now().getTime());
      // A copy this device kept says nothing about what the Worker holds now.
      if (answer.receivedAt === null) answeredBy.set(path, number);
      const shown = entries.get(path)?.data ?? null;
      // The same body opens differently once the key or the switch changes, so the epoch rides with it.
      const stamp = `${sealedEpoch()}:${answer.text}`;
      const same = shown !== null && answeredWith.get(path) === stamp;
      answeredWith.set(path, stamp);
      set(path, {
        data: same ? shown : answer.data,
        error: null,
        receivedAt: answer.receivedAt ?? now().toISOString(),
        fromCopy: answer.receivedAt !== null,
        loading: false,
        unreached: false,
      });
    })
    .catch((err: unknown) => {
      if (mine !== generation) return;
      endedSession(err);
      const message = err instanceof Error ? err.message : String(err);
      // What was on screen stays on screen. Never blank, never silently old.
      set(path, { ...(entries.get(path) ?? EMPTY), error: message, loading: false, unreached: !(err instanceof ApiError) });
    })
    .finally(() => {
      // A clear took this load's place: a load since then is not this one's to finish.
      if (mine !== generation) return;
      inflight.delete(path);
      if (again.delete(path)) void load(path, now);
    });
  inflight.set(path, work);
  return work;
}

/** Refetch everything something is showing. The live channel's one job. */
export function refetchShown(): void {
  for (const [path, count] of users) if (count > 0) void load(path);
}

/** Forget everything, for signing out, loads still on their way included. */
export function clearResources(): void {
  generation += 1;
  entries.clear();
  fetchedAt.clear();
  answeredBy.clear();
  answeredWith.clear();
  inflight.clear();
  again.clear();
  for (const listener of listeners) listener();
}

/** The number the next load to begin will carry. A write that has landed is in its answer. */
export function readsBegun(): number {
  return begun;
}

/** The paths something is showing now. */
function shownPaths(): string[] {
  return [...users].filter(([, count]) => count > 0).map(([path]) => path);
}

/**
 * Whether every path in `paths`, by default everything on screen, has been answered by the
 * Worker from a load numbered `since` or later. Then whatever a write that landed before
 * that load began did, or failed to do, is what the screen holds.
 */
export function readSince(since: number, paths: readonly string[] = shownPaths()): boolean {
  return paths.every((path) => (answeredBy.get(path) ?? -1) >= since);
}

/** `readSince` everything on screen, kept current. False while `since` is null: nothing to wait for. */
export function useReadSince(since: number | null): boolean {
  return useSyncExternalStore(subscribe, () => since !== null && readSince(since));
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** What a path holds now, as a screen showing it sees it. */
export function resourceAt<T>(path: string | null): Resource<T> {
  return (path === null ? EMPTY : entries.get(path) ?? EMPTY) as Resource<T>;
}

export function useResource<T>(path: string | null): Resource<T> & { readonly refetch: () => void } {
  const current = useSyncExternalStore(subscribe, () => resourceAt<T>(path));

  useEffect(() => {
    if (path === null) return;
    users.set(path, (users.get(path) ?? 0) + 1);
    // Nothing refetches a path while no screen shows it, so a screen opening again asks,
    // unless the answer it has is only a moment old.
    const seen = entries.get(path);
    const recent = Date.now() - (fetchedAt.get(path) ?? 0) < FRESH_MS;
    if (seen === undefined || (!inflight.has(path) && !recent)) void load(path);
    return () => {
      users.set(path, (users.get(path) ?? 1) - 1);
    };
  }, [path]);

  const refetch = useCallback(() => {
    if (path !== null) void load(path);
  }, [path]);

  return { ...current, refetch };
}
