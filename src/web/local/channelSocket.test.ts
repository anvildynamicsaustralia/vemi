import { describe, expect, it } from "vitest";
import type { Change } from "@vemi/shared";
import type { LocalChannel } from "../../local/channel.js";
import { PING_EVERY_MS, PONG_WITHIN_MS, REFETCH_DEBOUNCE_MS, connectLive, type LiveStatus } from "../state/live.js";
import { channelSocket } from "./channelSocket.js";

/** One name, many contexts: a post reaches every channel but the one that posted, as a BroadcastChannel does. */
function network() {
  const all = new Set<{ heard: (change: Change) => void }>();
  return {
    open(): LocalChannel & { readonly closed: boolean } {
      const listeners = new Set<(change: Change) => void>();
      const me = { heard: (change: Change) => listeners.forEach((l) => l(change)) };
      all.add(me);
      const channel = {
        closed: false,
        post: (change: Change) => { for (const other of all) if (other !== me) other.heard(change); },
        listen: (onChange: (change: Change) => void) => {
          listeners.add(onChange);
          return () => listeners.delete(onChange);
        },
        close: () => { channel.closed = true; all.delete(me); },
      };
      return channel;
    },
  };
}

function clock() {
  let now = 0;
  let nextId = 1;
  const pending: { id: number; at: number; fn: () => void }[] = [];
  return {
    now: () => now,
    set: (fn: () => void, ms: number): unknown => {
      const id = nextId++;
      pending.push({ id, at: now + ms, fn });
      return id;
    },
    clear: (handle: unknown): void => {
      const i = pending.findIndex((p) => p.id === handle);
      if (i >= 0) pending.splice(i, 1);
    },
    advance(ms: number): void {
      const until = now + ms;
      for (;;) {
        pending.sort((a, b) => a.at - b.at);
        const first = pending[0];
        if (first === undefined || first.at > until) break;
        pending.shift();
        now = first.at;
        first.fn();
      }
      now = until;
    },
  };
}

const CHANGE: Change = { kind: "tasks", id: "t1", ventureId: "v1" };

function page(net: ReturnType<typeof network>) {
  const time = clock();
  const statuses: LiveStatus[] = [];
  let changes = 0;
  const mine = net.open();
  const handle = connectLive({
    url: "wss://example.test/api/live",
    socket: () => channelSocket(mine, (work) => time.set(work, 0)),
    onChange: () => { changes += 1; },
    onStatus: (s) => statuses.push(s),
    setTimer: time.set,
    clearTimer: time.clear,
    now: time.now,
  });
  return { time, statuses, handle, mine, changes: () => changes };
}

describe("live updates between tabs in local mode", () => {
  it("opens at once and says live", () => {
    const tab = page(network());
    expect(tab.statuses).toEqual(["connecting"]);
    tab.time.advance(0);
    expect(tab.statuses).toEqual(["connecting", "live"]);
  });

  it("refetches once when another tab's database worker posts a change", () => {
    const net = network();
    const tab = page(net);
    tab.time.advance(0);
    const other = net.open();
    other.post(CHANGE);
    other.post({ ...CHANGE, id: "t2" });
    tab.time.advance(REFETCH_DEBOUNCE_MS);
    expect(tab.changes()).toBe(1);
  });

  it("shows a tab that owns the database its own changes: its worker is another context on the channel", () => {
    const net = network();
    const owner = page(net);
    owner.time.advance(0);
    const ownerWorker = net.open();
    ownerWorker.post(CHANGE);
    owner.time.advance(REFETCH_DEBOUNCE_MS);
    expect(owner.changes()).toBe(1);
  });

  it("answers the live client's ping so it never reads the channel as gone", () => {
    const tab = page(network());
    tab.time.advance(0);
    tab.time.advance(PING_EVERY_MS + PONG_WITHIN_MS + 1);
    expect(tab.statuses).toEqual(["connecting", "live"]);
  });

  it("lets go of the channel on close and hears nothing after", () => {
    const net = network();
    const tab = page(net);
    tab.time.advance(0);
    tab.handle.close();
    expect(tab.mine.closed).toBe(true);
    net.open().post(CHANGE);
    tab.time.advance(REFETCH_DEBOUNCE_MS);
    expect(tab.changes()).toBe(0);
  });
});
