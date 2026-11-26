/**
 * The live channel. The Worker's Durable Object sends `{ kind, id, ventureId }` after every
 * write, and carries no record, so it can never disagree with the database.
 *
 * A message is a reason to refetch, never a patch. So is every successful reconnect,
 * because messages sent while the socket was down are gone for good.
 *
 * A phone that sleeps can lose its socket without a close ever arriving, and the channel
 * would go on saying "live" while hearing nothing. So it pings, and a ping with no pong in
 * time counts as a close.
 */

/** One write can touch several things. Collapse a burst into one refetch. */
export const REFETCH_DEBOUNCE_MS = 150;
export const BACKOFF_START_MS = 1_000;
/** Capped so a connection that was gone for an hour is picked up promptly on return. */
export const BACKOFF_MAX_MS = 15_000;
/** The Durable Object answers "ping" with "pong" without waking. */
export const PING_EVERY_MS = 25_000;
export const PONG_WITHIN_MS = 10_000;
/**
 * The first connection refetches only if it took longer than this to open. The screens
 * fetched when they opened; a socket open within a moment of that has missed nothing worth
 * a second round of every read.
 */
export const FIRST_OPEN_GRACE_MS = 3_000;

export type LiveStatus = "connecting" | "live" | "offline";

/** The slice of WebSocket this uses, so a test can stand one up in a few lines. */
export interface SocketLike {
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: unknown) => void) | null;
  onclose: ((event: unknown) => void) | null;
  onerror: ((event: unknown) => void) | null;
  send(data: string): void;
  close(): void;
}

export interface LiveOptions {
  readonly onChange: () => void;
  /** Also called, once per message, when the write was a connected app's. */
  readonly onConnector?: () => void;
  readonly onStatus: (status: LiveStatus) => void;
  readonly url?: string;
  readonly socket?: (url: string) => SocketLike;
  readonly setTimer?: (fn: () => void, ms: number) => unknown;
  readonly clearTimer?: (handle: unknown) => void;
  readonly now?: () => number;
}

export interface LiveHandle {
  readonly close: () => void;
  /** Check the connection now, for a page that has just become visible again. */
  readonly nudge: () => void;
}

/** Whether a live message says a connected app made the write. Anything unreadable says no. */
export function fromConnector(data: unknown): boolean {
  if (typeof data !== "string") return false;
  try {
    return (JSON.parse(data) as { via?: unknown } | null)?.via === "connector";
  } catch {
    return false;
  }
}

export function liveUrl(page: string): string {
  const url = new URL("/api/live", page);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

export function backoffAfter(previous: number): number {
  return Math.min(BACKOFF_MAX_MS, previous * 2);
}

export function connectLive(opts: LiveOptions): LiveHandle {
  const url = opts.url ?? liveUrl(window.location.href);
  const makeSocket = opts.socket ?? ((u: string) => new WebSocket(u) as unknown as SocketLike);
  const setTimer = opts.setTimer ?? ((fn: () => void, ms: number) => window.setTimeout(fn, ms));
  const clearTimer = opts.clearTimer ?? ((h: unknown) => window.clearTimeout(h as number));
  const now = opts.now ?? (() => Date.now());
  const startedAt = now();

  let closed = false;
  let opened = false;
  let socket: SocketLike | null = null;
  let live = false;
  let backoff = BACKOFF_START_MS;
  let debounce: unknown = null;
  let retry: unknown = null;
  let pinging: unknown = null;
  let waitingForPong: unknown = null;

  const changed = (): void => {
    if (debounce !== null) clearTimer(debounce);
    debounce = setTimer(() => {
      debounce = null;
      if (!closed) opts.onChange();
    }, REFETCH_DEBOUNCE_MS);
  };

  const quiet = (): void => {
    if (pinging !== null) clearTimer(pinging);
    if (waitingForPong !== null) clearTimer(waitingForPong);
    pinging = null;
    waitingForPong = null;
  };

  const ping = (s: SocketLike): void => {
    if (closed || socket !== s || waitingForPong !== null) return;
    try {
      s.send("ping");
    } catch {
      lost(s);
      return;
    }
    waitingForPong = setTimer(() => {
      waitingForPong = null;
      // Nothing came back. Treat it as gone rather than wait for a close that may never come.
      lost(s);
    }, PONG_WITHIN_MS);
  };

  const schedulePing = (s: SocketLike): void => {
    if (pinging !== null) clearTimer(pinging);
    pinging = setTimer(() => {
      pinging = null;
      ping(s);
      schedulePing(s);
    }, PING_EVERY_MS);
  };

  let failures = 0;

  const lost = (s: SocketLike): void => {
    if (closed || socket !== s) return;
    failures += 1;
    socket = null;
    live = false;
    quiet();
    try {
      s.close();
    } catch {
      // Already closed.
    }
    opts.onStatus("offline");
    retry = setTimer(() => {
      retry = null;
      open();
    }, backoff);
    backoff = backoffAfter(backoff);
  };

  const open = (): void => {
    if (closed) return;
    const s = makeSocket(url);
    socket = s;
    s.onopen = () => {
      if (closed || socket !== s) return;
      // Recovering from a failure, even one before the first open: the reads made meanwhile
      // may have failed too.
      const recovering = failures > 0;
      failures = 0;
      backoff = BACKOFF_START_MS;
      live = true;
      opts.onStatus("live");
      if (opened || recovering || now() - startedAt > FIRST_OPEN_GRACE_MS) changed();
      opened = true;
      schedulePing(s);
    };
    s.onmessage = (event: unknown) => {
      if (closed || socket !== s) return;
      // Anything heard proves the socket is alive.
      if (waitingForPong !== null) {
        clearTimer(waitingForPong);
        waitingForPong = null;
      }
      const data = (event as { data?: unknown } | null)?.data;
      if (data === "pong") return;
      if (fromConnector(data)) opts.onConnector?.();
      changed();
    };
    // An error is always followed by a close, so the close is the one place that retries.
    s.onerror = () => {};
    s.onclose = () => lost(s);
  };

  opts.onStatus("connecting");
  open();

  return {
    close: () => {
      closed = true;
      quiet();
      if (debounce !== null) clearTimer(debounce);
      if (retry !== null) clearTimer(retry);
      socket?.close();
      socket = null;
    },
    nudge: () => {
      if (closed) return;
      if (socket !== null && live) {
        ping(socket);
        return;
      }
      // Waiting out a backoff: try now instead.
      if (retry !== null) {
        clearTimer(retry);
        retry = null;
        backoff = BACKOFF_START_MS;
        open();
      }
    },
  };
}
