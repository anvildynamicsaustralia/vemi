import { describe, expect, it, vi } from "vitest";
import type { Reminder } from "../reminderEvent.js";
import { askForDue, startTicker, TICK_EVERY_MS, type Visibility } from "./ticker.js";

function page(initial: DocumentVisibilityState = "visible") {
  const listeners = new Set<() => void>();
  const view: Visibility & { visibilityState: DocumentVisibilityState } = {
    visibilityState: initial,
    addEventListener: (_type, l) => void listeners.add(l),
    removeEventListener: (_type, l) => void listeners.delete(l),
  };
  return {
    view,
    set(state: DocumentVisibilityState): void {
      view.visibilityState = state;
      listeners.forEach((l) => l());
    },
    listening: () => listeners.size,
  };
}

function harness(initial: DocumentVisibilityState = "visible") {
  let clock = new Date("2026-11-18T00:00:00Z");
  const timers: { fn: () => void; ms: number; id: number }[] = [];
  const asked: (Date | null)[] = [];
  const shown: Reminder[] = [];
  let due: Reminder[] = [];
  const view = page(initial);
  const stop = startTicker({
    run: async (since) => { asked.push(since); const out = due; due = []; return out; },
    show: (r) => shown.push(r),
    page: view.view,
    now: () => clock,
    setTimer: (fn, ms) => { const id = timers.length + 1; timers.push({ fn, ms, id }); return id; },
    clearTimer: (id) => { const i = timers.findIndex((t) => t.id === id); if (i >= 0) timers.splice(i, 1); },
  });
  return {
    view, stop, asked, shown, timers,
    setDue: (next: Reminder[]) => { due = next; },
    minute: async () => { clock = new Date(clock.getTime() + TICK_EVERY_MS); timers[0]?.fn(); await flush(); },
    advance: (ms: number) => { clock = new Date(clock.getTime() + ms); },
  };
}
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

const REMINDER: Reminder = { taskId: "t1", at: "2026-11-18T09:30" };

describe("the page's reminder check", () => {
  it("checks on opening and then every minute, and shows what is due", async () => {
    const h = harness();
    await flush();
    expect(h.timers[0]?.ms).toBe(60_000);
    expect(h.asked).toEqual([null]);
    h.setDue([REMINDER]);
    await h.minute();
    expect(h.asked).toHaveLength(2);
    expect(h.shown).toEqual([REMINDER]);
  });

  it("runs nothing while the page is hidden, and checks the moment it is seen, saying how long it was hidden", async () => {
    const h = harness();
    await flush();
    h.view.set("hidden");
    h.advance(10 * 60_000);
    h.setDue([REMINDER]);
    await h.minute();
    expect(h.asked).toHaveLength(1);
    expect(h.shown).toEqual([]);
    h.view.set("visible");
    await flush();
    expect(h.asked).toHaveLength(2);
    expect(h.asked[1]).toEqual(new Date("2026-11-18T00:00:00Z"));
    expect(h.shown).toEqual([REMINDER]);
  });

  it("checks on opening in view only, and stops listening when stopped", async () => {
    const h = harness("hidden");
    await flush();
    expect(h.asked).toEqual([]);
    h.stop();
    expect(h.view.listening()).toBe(0);
    expect(h.timers).toEqual([]);
  });
});

describe("askForDue", () => {
  it("posts to the bridge with when the page went out of view, and answers what is due", async () => {
    const doFetch = vi.fn(async () => new Response(JSON.stringify({ due: [REMINDER] }))) as unknown as typeof fetch;
    const run = askForDue(doFetch);
    expect(await run(new Date("2026-11-18T00:00:00Z"))).toEqual([REMINDER]);
    expect(doFetch).toHaveBeenCalledWith("/api/local/tick", expect.objectContaining({
      method: "POST", body: JSON.stringify({ hiddenSince: "2026-11-18T00:00:00.000Z" }),
    }));
  });

  it("throws when the check is refused, so the ticker asks again next minute", async () => {
    const run = askForDue((async () => new Response("{}", { status: 500 })) as unknown as typeof fetch);
    await expect(run(null)).rejects.toThrow();
  });
});
