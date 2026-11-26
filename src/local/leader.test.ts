import { describe, expect, it } from "vitest";
import { createLeader, type Leader, type LockManagerLike, type Owner, type PostChannel } from "./leader.js";
import type { WireRequest, WireResponse } from "./bridge.js";

/** A lock manager that grants a name to one holder at a time, in the order asked, like the browser's. */
function fakeLocks(): LockManagerLike {
  const queues = new Map<string, Promise<unknown>>();
  return {
    request: (name, callback) => {
      const before = queues.get(name) ?? Promise.resolve();
      const mine = before.then(() => callback());
      queues.set(name, mine.catch(() => undefined));
      return mine;
    },
  };
}

type Listener = (event: { data: unknown }) => void;

/** Channels that reach every other channel on the same bus, as `BroadcastChannel` does. */
function fakeBus(): () => PostChannel {
  const members = new Set<{ listeners: Set<Listener> }>();
  return () => {
    const me = { listeners: new Set<Listener>() };
    members.add(me);
    return {
      postMessage: (data) => {
        const copy = structuredClone(data);
        for (const other of members) {
          if (other === me) continue;
          queueMicrotask(() => { for (const listener of other.listeners) listener({ data: copy }); });
        }
      },
      addEventListener: (_type, listener) => { me.listeners.add(listener); },
      removeEventListener: (_type, listener) => { me.listeners.delete(listener); },
      close: () => { members.delete(me); },
    };
  };
}

const wire = (path: string, body = ""): WireRequest => ({
  method: "POST", url: `https://vemi.test${path}`, headers: [], body: new TextEncoder().encode(body).buffer as ArrayBuffer,
});
const answer = (value: string): WireResponse => ({ status: 200, headers: [], body: new TextEncoder().encode(value).buffer as ArrayBuffer });
const text = (response: WireResponse): string => new TextDecoder().decode(response.body);

interface Log { events: string[] }

/** An owner that answers with its tab's name and the path. `hold` keeps answers pending until released. */
function ownerFor(name: string, log: Log, hold?: { release: Promise<void> }): () => Promise<Owner> {
  return async () => {
    log.events.push(`${name} opened`);
    return {
      volatile: false,
      send: async (request) => {
        if (hold) await hold.release;
        return answer(`${name}:${new URL(request.url).pathname}`);
      },
      close: () => { log.events.push(`${name} closed`); },
    };
  };
}

const quick = { ackMs: 15, deadlineMs: 400 };
const settle = (ms = 40): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const unreachable = async (work: Promise<unknown>): Promise<boolean> => {
  try { await work; return false; } catch (error) { return error instanceof TypeError; }
};

describe("one tab owns the database", () => {
  it("the first tab to ask owns it and answers for itself", async () => {
    const log: Log = { events: [] };
    const leader = createLeader({ locks: fakeLocks(), openChannel: fakeBus(), startOwner: ownerFor("a", log), ...quick });
    expect(text(await leader.send(wire("/api/x")))).toBe("a:/api/x");
    expect(leader.status().role).toBe("owner");
    await leader.close();
  });

  it("another tab sends its requests to the owner and waits for the answer", async () => {
    const log: Log = { events: [] };
    const locks = fakeLocks();
    const open = fakeBus();
    const a = createLeader({ locks, openChannel: open, startOwner: ownerFor("a", log), ...quick });
    await a.send(wire("/api/first"));
    const b = createLeader({ locks, openChannel: open, startOwner: ownerFor("b", log), ...quick });
    expect(text(await b.send(wire("/api/second")))).toBe("a:/api/second");
    expect(b.status().role).toBe("follower");
    expect(log.events).toEqual(["a opened"]);
    await a.close();
    await b.close();
  });

  it("when the owner closes, the next tab opens the same database and answers", async () => {
    const log: Log = { events: [] };
    const locks = fakeLocks();
    const open = fakeBus();
    const a = createLeader({ locks, openChannel: open, startOwner: ownerFor("a", log), ...quick });
    await a.send(wire("/api/first"));
    const b = createLeader({ locks, openChannel: open, startOwner: ownerFor("b", log), ...quick });
    await b.send(wire("/api/second"));
    const c = createLeader({ locks, openChannel: open, startOwner: ownerFor("c", log), ...quick });
    await c.send(wire("/api/third"));
    await a.close();
    expect(text(await b.send(wire("/api/after")))).toBe("b:/api/after");
    expect(b.status().role).toBe("owner");
    // c now asks b, and the old owner was closed before the new one opened.
    expect(text(await c.send(wire("/api/other")))).toBe("b:/api/other");
    expect(log.events).toEqual(["a opened", "a closed", "b opened"]);
    await b.close();
    await c.close();
  });

  it("a request in flight when the owner closes fails as unreachable, and does not hang", async () => {
    const log: Log = { events: [] };
    const locks = fakeLocks();
    const open = fakeBus();
    let release!: () => void;
    const hold = { release: new Promise<void>((resolve) => { release = resolve; }) };
    const a = createLeader({ locks, openChannel: open, startOwner: ownerFor("a", log, hold), ...quick });
    const b = createLeader({ locks, openChannel: open, startOwner: ownerFor("b", log), ...quick });
    const stuckResult = unreachable(b.send(wire("/api/slow")));
    await settle();
    void a.close();
    release();
    expect(await stuckResult).toBe(true);
    expect(text(await b.send(wire("/api/next")))).toBe("b:/api/next");
    await b.close();
  });

  it("a request the owner never took up is answered by the tab that becomes owner", async () => {
    const log: Log = { events: [] };
    const locks = fakeLocks();
    const open = fakeBus();
    // `a` holds the lock but is still opening the database when it gives up.
    let fail!: () => void;
    const slow = new Promise<void>((resolve) => { fail = resolve; });
    const a = createLeader({
      locks, openChannel: open, ...quick,
      startOwner: async () => { await slow; throw new Error("never opened"); },
    });
    await settle();
    const b = createLeader({ locks, openChannel: open, startOwner: ownerFor("b", log), ...quick });
    const pending = b.send(wire("/api/early"));
    await settle();
    fail();
    expect(text(await pending)).toBe("b:/api/early");
    await a.close();
    await b.close();
  });

  it("a request nobody answers fails as unreachable by its deadline", async () => {
    const locks = fakeLocks();
    const open = fakeBus();
    // `a` takes the lock and never finishes opening.
    const a = createLeader({ locks, openChannel: open, startOwner: () => new Promise<Owner>(() => undefined), ...quick, deadlineMs: 120 });
    await settle();
    const b = createLeader({ locks, openChannel: open, startOwner: ownerFor("b", { events: [] }), ...quick, deadlineMs: 120 });
    expect(await unreachable(b.send(wire("/api/lost")))).toBe(true);
    void a;
  });

  it("tells every tab whether what it keeps is only for this session", async () => {
    const locks = fakeLocks();
    const open = fakeBus();
    const volatileOwner = async (): Promise<Owner> => ({ volatile: true, send: async () => answer("ok"), close: () => undefined });
    const a: Leader = createLeader({ locks, openChannel: open, startOwner: volatileOwner, ...quick });
    await a.send(wire("/api/x"));
    const b = createLeader({ locks, openChannel: open, startOwner: volatileOwner, ...quick });
    const heard: (boolean | null)[] = [];
    b.onStatus((status) => heard.push(status.volatile));
    await b.send(wire("/api/y"));
    expect(a.status().volatile).toBe(true);
    expect(b.status().volatile).toBe(true);
    expect(heard).toContain(true);
    await a.close();
    await b.close();
  });

  it("a closed leader refuses new requests as unreachable", async () => {
    const leader = createLeader({ locks: fakeLocks(), openChannel: fakeBus(), startOwner: ownerFor("a", { events: [] }), ...quick });
    await leader.send(wire("/api/x"));
    await leader.close();
    expect(await unreachable(leader.send(wire("/api/y")))).toBe(true);
  });
});
