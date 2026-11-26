/**
 * One tab owns the database; every other tab asks it.
 *
 * The database lives in the browser's private file system and only one worker may hold it
 * open. So each tab takes a Web Lock named `vemi-local-db`: the tab that is granted it starts
 * the database worker and answers for every tab; the others send each request over a
 * `BroadcastChannel` and wait. When the owner closes (or the browser drops it) the lock passes
 * to the next tab in line, which opens the same database.
 *
 * A request never hangs. One the owner has not yet taken up is asked again until somebody
 * answers, and is answered by this very tab if it becomes the owner. One the owner had taken up
 * when it went away, or that nobody answers by its deadline, fails with a `TypeError`, the way an
 * offline `fetch` does, so the outbox keeps a write and tries again.
 *
 * `createLeader` takes the lock manager, the channel and the way to start the database as
 * arguments, so a test can drive it with fakes; `openBrowserLeader` wires the real ones.
 */
import type { WireRequest, WireResponse } from "./bridge.js";
import type { WorkerIn, WorkerOut } from "./workerMessages.js";

export const LOCK_NAME = "vemi-local-db";
export const REQUEST_CHANNEL = "vemi-local-db";

export interface LockManagerLike {
  /** Holds `name` until the promise `callback` returns settles; the next asker is then granted it. */
  request(name: string, callback: () => Promise<unknown>): Promise<unknown>;
}

type Listener = (event: { data: unknown }) => void;

/** The part of `BroadcastChannel` the leader uses. */
export interface PostChannel {
  postMessage(data: unknown): void;
  addEventListener(type: "message", listener: Listener): void;
  removeEventListener(type: "message", listener: Listener): void;
  close(): void;
}

/** The open database, as the tab that owns it sees it. */
export interface Owner {
  /** True when what is kept lasts only until this page closes. */
  readonly volatile: boolean;
  send(wire: WireRequest): Promise<WireResponse>;
  close(): void | Promise<void>;
}

export type Role = "follower" | "owner" | "closed";

export interface LeaderStatus {
  readonly role: Role;
  /** Null until some tab has opened the database and said. */
  readonly volatile: boolean | null;
}

export interface Leader {
  send(wire: WireRequest): Promise<WireResponse>;
  status(): LeaderStatus;
  onStatus(listener: (status: LeaderStatus) => void): () => void;
  close(): Promise<void>;
}

export interface LeaderOptions {
  readonly locks: LockManagerLike;
  readonly openChannel: () => PostChannel;
  readonly startOwner: () => Promise<Owner>;
  /** How long to wait for the owner to take a request up before asking again. */
  readonly ackMs?: number;
  /** How long any one request may wait in all. */
  readonly deadlineMs?: number;
}

type Message =
  | { kind: "req"; id: string; wire: WireRequest }
  | { kind: "ack"; id: string; owner: string }
  | { kind: "res"; id: string; wire?: WireResponse; failed?: string }
  | { kind: "ready"; owner: string; volatile: boolean }
  | { kind: "gone"; owner: string }
  | { kind: "hello" };

interface Pending {
  readonly wire: WireRequest;
  readonly resolve: (response: WireResponse) => void;
  readonly reject: (error: unknown) => void;
  ackedBy: string | null;
  readonly again: ReturnType<typeof setInterval>;
  readonly deadline: ReturnType<typeof setTimeout>;
}

const unreachable = (): TypeError => new TypeError("Failed to fetch");

let tabs = 0;

export function createLeader(options: LeaderOptions): Leader {
  const ackMs = options.ackMs ?? 500;
  const deadlineMs = options.deadlineMs ?? 60_000;
  const id = `tab${++tabs}-${Math.random().toString(36).slice(2, 8)}`;
  const channel = options.openChannel();

  let role: Role = "follower";
  let volatile: boolean | null = null;
  let owner: Owner | null = null;
  let holding = false;
  let closed = false;
  let counter = 0;
  const pending = new Map<string, Pending>();
  const serving = new Set<string>();
  const listeners = new Set<(status: LeaderStatus) => void>();

  const status = (): LeaderStatus => ({ role, volatile });
  const tell = (): void => {
    for (const listener of [...listeners]) listener(status());
  };
  const post = (message: Message): void => {
    if (!closed || message.kind === "gone") channel.postMessage(message);
  };

  const settle = (requestId: string): Pending | undefined => {
    const entry = pending.get(requestId);
    if (entry === undefined) return undefined;
    pending.delete(requestId);
    clearInterval(entry.again);
    clearTimeout(entry.deadline);
    return entry;
  };
  const fail = (requestId: string): void => settle(requestId)?.reject(unreachable());
  const failTakenUpBy = (matches: (by: string) => boolean): void => {
    for (const [requestId, entry] of [...pending]) {
      if (entry.ackedBy !== null && matches(entry.ackedBy)) fail(requestId);
    }
  };

  /** Answers a request that came over the channel, from the database this tab holds. */
  const serve = (request: Extract<Message, { kind: "req" }>): void => {
    if (owner === null || serving.has(request.id)) {
      if (owner !== null) post({ kind: "ack", id: request.id, owner: id });
      return;
    }
    serving.add(request.id);
    post({ kind: "ack", id: request.id, owner: id });
    owner.send(request.wire).then(
      (wire) => post({ kind: "res", id: request.id, wire }),
      (error: unknown) => post({ kind: "res", id: request.id, failed: error instanceof Error ? error.message : "failed" }),
    ).finally(() => serving.delete(request.id));
  };

  const onMessage: Listener = (event) => {
    const message = event.data as Message;
    switch (message.kind) {
      case "req":
        serve(message);
        break;
      case "hello":
        if (owner !== null) post({ kind: "ready", owner: id, volatile: owner.volatile });
        break;
      case "ack": {
        const entry = pending.get(message.id);
        if (entry !== undefined) entry.ackedBy = message.owner;
        break;
      }
      case "res": {
        const entry = settle(message.id);
        if (entry === undefined) break;
        if (message.wire !== undefined) entry.resolve(message.wire);
        else entry.reject(unreachable());
        break;
      }
      case "ready":
        if (message.owner === id) break;
        // A different owner than the one that took a request up: that request is lost with it.
        failTakenUpBy((by) => by !== message.owner);
        volatile = message.volatile;
        for (const [requestId, entry] of pending) {
          if (entry.ackedBy === null) post({ kind: "req", id: requestId, wire: entry.wire });
        }
        tell();
        break;
      case "gone":
        failTakenUpBy((by) => by === message.owner);
        break;
    }
  };
  channel.addEventListener("message", onMessage);

  /** This tab has the lock. Open the database, answer what is waiting, then say so. */
  const becomeOwner = async (): Promise<boolean> => {
    let opened: Owner;
    try {
      opened = await options.startOwner();
    } catch {
      return false;
    }
    if (closed) {
      await opened.close();
      return false;
    }
    owner = opened;
    role = "owner";
    volatile = opened.volatile;
    // Whatever another owner had taken up went with it; what nobody had is answered here.
    failTakenUpBy(() => true);
    for (const [requestId, entry] of [...pending]) {
      settle(requestId);
      opened.send(entry.wire).then(entry.resolve, entry.reject);
    }
    post({ kind: "ready", owner: id, volatile: opened.volatile });
    tell();
    return true;
  };

  let release: () => void = () => undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const done: Promise<unknown> = options.locks
    .request(LOCK_NAME, async () => {
      if (closed) return;
      holding = true;
      if (await becomeOwner()) await held;
      const current = owner;
      owner = null;
      if (current !== null) {
        post({ kind: "gone", owner: id });
        await current.close();
      }
      holding = false;
    })
    .catch(() => undefined);

  post({ kind: "hello" });

  return {
    status,
    onStatus: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    send: (wire) => {
      if (closed) return Promise.reject(unreachable());
      if (owner !== null) return owner.send(wire);
      return new Promise<WireResponse>((resolve, reject) => {
        const requestId = `${id}.${++counter}`;
        const again = setInterval(() => {
          if (pending.get(requestId)?.ackedBy === null) post({ kind: "req", id: requestId, wire });
        }, ackMs);
        const deadline = setTimeout(() => fail(requestId), deadlineMs);
        pending.set(requestId, { wire, resolve, reject, ackedBy: null, again, deadline });
        post({ kind: "req", id: requestId, wire });
      });
    },
    close: async () => {
      if (closed) return;
      closed = true;
      for (const requestId of [...pending.keys()]) fail(requestId);
      channel.removeEventListener("message", onMessage);
      release();
      if (holding) await done;
      role = "closed";
      channel.close();
      tell();
    },
  };
}

/** The real thing: the browser's lock manager, its `BroadcastChannel`, and a database worker. */
export function openBrowserLeader(): Leader {
  return createLeader({
    locks: navigator.locks as unknown as LockManagerLike,
    openChannel: () => new BroadcastChannel(REQUEST_CHANNEL) as unknown as PostChannel,
    startOwner: startWorkerOwner,
  });
}

/** Starts the database worker and waits until it has opened the database. */
export async function startWorkerOwner(): Promise<Owner> {
  const worker = new Worker(new URL("./dbWorker.ts", import.meta.url), { type: "module" });
  const waiting = new Map<number, { resolve: (wire: WireResponse) => void; reject: (error: unknown) => void }>();
  let counter = 0;
  let closing: (() => void) | null = null;

  const broken = (): void => {
    for (const entry of waiting.values()) entry.reject(unreachable());
    waiting.clear();
  };

  const volatile = await new Promise<boolean>((resolve, reject) => {
    worker.onmessage = (event: MessageEvent<WorkerOut>) => {
      const message = event.data;
      switch (message.type) {
        case "ready":
          resolve(message.volatile);
          break;
        case "broken":
          reject(new Error(message.message));
          break;
        case "answer":
          waiting.get(message.id)?.resolve(message.wire);
          waiting.delete(message.id);
          break;
        case "failed":
          waiting.get(message.id)?.reject(unreachable());
          waiting.delete(message.id);
          break;
        case "closed":
          closing?.();
          break;
      }
    };
    worker.onerror = () => {
      reject(new Error("The database worker stopped."));
      broken();
    };
    worker.postMessage({ type: "open" } satisfies WorkerIn);
  }).catch((error: unknown) => {
    worker.terminate();
    throw error;
  });

  const tell = (message: WorkerIn): void => worker.postMessage(message);
  return {
    volatile,
    send: (wire) =>
      new Promise<WireResponse>((resolve, reject) => {
        const requestId = ++counter;
        waiting.set(requestId, { resolve, reject });
        tell({ type: "request", id: requestId, wire });
      }),
    close: async () => {
      const closedByWorker = new Promise<void>((resolve) => {
        closing = resolve;
      });
      tell({ type: "close" });
      // The worker lets go of the file, then is stopped; a stuck worker is stopped anyway.
      await Promise.race([closedByWorker, new Promise<void>((resolve) => setTimeout(resolve, 2000))]);
      worker.terminate();
      broken();
    },
  };
}
