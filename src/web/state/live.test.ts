import { describe, expect, it } from "vitest";
import {
  BACKOFF_START_MS, FIRST_OPEN_GRACE_MS, PING_EVERY_MS, PONG_WITHIN_MS, REFETCH_DEBOUNCE_MS,
  connectLive, fromConnector, liveUrl, type LiveStatus, type SocketLike,
} from "./live.js";

class FakeSocket implements SocketLike {
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: unknown) => void) | null = null;
  onclose: ((event: unknown) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  closed = false;
  sent: string[] = [];
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.closed = true;
  }
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

function harness() {
  const sockets: FakeSocket[] = [];
  const statuses: LiveStatus[] = [];
  let changes = 0;
  const time = clock();
  const handle = connectLive({
    url: "wss://example.test/api/live",
    socket: () => {
      const s = new FakeSocket();
      sockets.push(s);
      return s;
    },
    onChange: () => { changes += 1; },
    onStatus: (s) => statuses.push(s),
    setTimer: time.set,
    clearTimer: time.clear,
    now: time.now,
  });
  return { sockets, statuses, time, handle, changes: () => changes };
}

describe("the live channel", () => {
  it("tells apart a message from a connected app's write", () => {
    expect(fromConnector(JSON.stringify({ kind: "tasks", id: "a", ventureId: null, via: "connector" }))).toBe(true);
    expect(fromConnector(JSON.stringify({ kind: "tasks", id: "a", ventureId: null }))).toBe(false);
    for (const other of ["{}", "pong", "null", "not json", 5, undefined]) expect(fromConnector(other)).toBe(false);
  });

  it("calls onConnector for a connector message only, and still refetches for both", () => {
    let heard = 0;
    let changed = 0;
    const time = clock();
    const sockets: FakeSocket[] = [];
    connectLive({
      url: "ws://x", socket: () => { const s = new FakeSocket(); sockets.push(s); return s; },
      onChange: () => { changed += 1; }, onConnector: () => { heard += 1; }, onStatus: () => {},
      setTimer: time.set, clearTimer: time.clear, now: time.now,
    });
    sockets[0]!.onopen?.({});
    sockets[0]!.onmessage?.({ data: JSON.stringify({ kind: "tasks", id: "a", ventureId: null }) });
    expect(heard).toBe(0);
    time.advance(REFETCH_DEBOUNCE_MS);
    sockets[0]!.onmessage?.({ data: JSON.stringify({ kind: "tasks", id: "a", ventureId: null, via: "connector" }) });
    expect(heard).toBe(1);
    time.advance(REFETCH_DEBOUNCE_MS);
    expect(changed).toBe(2);
  });

  it("builds its address from the page's own origin", () => {
    expect(liveUrl("https://vemi.example.dev/today?task=1")).toBe("wss://vemi.example.dev/api/live");
    expect(liveUrl("http://localhost:5173/")).toBe("ws://localhost:5173/api/live");
  });

  it("does not refetch everything when the first connection opens promptly, and refetches once for a burst", () => {
    const h = harness();
    const socket = h.sockets[0]!;
    socket.onopen?.({});
    expect(h.statuses).toEqual(["connecting", "live"]);
    h.time.advance(REFETCH_DEBOUNCE_MS);
    expect(h.changes()).toBe(0);

    socket.onmessage?.({ data: "{}" });
    socket.onmessage?.({ data: "{}" });
    socket.onmessage?.({ data: "{}" });
    h.time.advance(REFETCH_DEBOUNCE_MS);
    expect(h.changes()).toBe(1);
  });

  it("refetches when the first connection was slow to open", () => {
    const h = harness();
    h.time.advance(FIRST_OPEN_GRACE_MS + 1);
    h.sockets[0]!.onopen?.({});
    h.time.advance(REFETCH_DEBOUNCE_MS);
    expect(h.changes()).toBe(1);
  });

  it("reconnects after a close, waiting longer each time, and refetches when it is back", () => {
    const h = harness();
    h.sockets[0]!.onclose?.({});
    expect(h.statuses.at(-1)).toBe("offline");
    h.time.advance(BACKOFF_START_MS);
    expect(h.sockets).toHaveLength(2);

    h.sockets[1]!.onclose?.({});
    h.time.advance(BACKOFF_START_MS);
    expect(h.sockets).toHaveLength(2);
    h.time.advance(BACKOFF_START_MS);
    expect(h.sockets).toHaveLength(3);

    h.sockets[2]!.onopen?.({});
    h.time.advance(REFETCH_DEBOUNCE_MS);
    expect(h.statuses.at(-1)).toBe("live");
    expect(h.changes()).toBe(1);
  });

  it("pings, and a pong keeps it live without a refetch", () => {
    const h = harness();
    const socket = h.sockets[0]!;
    socket.onopen?.({});
    h.time.advance(PING_EVERY_MS);
    expect(socket.sent).toEqual(["ping"]);
    socket.onmessage?.({ data: "pong" });
    h.time.advance(PONG_WITHIN_MS + REFETCH_DEBOUNCE_MS);
    expect(h.statuses.at(-1)).toBe("live");
    expect(h.sockets).toHaveLength(1);
    expect(h.changes()).toBe(0);
  });

  it("treats a ping with no answer as a lost connection and reconnects", () => {
    const h = harness();
    const socket = h.sockets[0]!;
    socket.onopen?.({});
    h.time.advance(PING_EVERY_MS + PONG_WITHIN_MS);
    expect(socket.closed).toBe(true);
    expect(h.statuses.at(-1)).toBe("offline");
    h.time.advance(BACKOFF_START_MS);
    expect(h.sockets).toHaveLength(2);
  });

  it("a nudge while waiting out a backoff tries again at once", () => {
    const h = harness();
    h.sockets[0]!.onclose?.({});
    h.handle.nudge();
    expect(h.sockets).toHaveLength(2);
  });

  it("stops for good when closed", () => {
    const h = harness();
    h.handle.close();
    expect(h.sockets[0]!.closed).toBe(true);
    h.sockets[0]!.onclose?.({});
    h.time.advance(60_000);
    expect(h.sockets).toHaveLength(1);
  });
});
