import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { seal, type PushPayload } from "@vemi/shared";
import { actBody, inAppFor, listenForPush, notificationFor, openUrlFor, shownPayload, OPEN_MESSAGE, PUSH_MESSAGE } from "./pushMessage.js";

const task: PushPayload = { kind: "task", title: "Ring the plumber", body: "Due now", taskId: "t1", at: "2026-11-18T09:30", tag: "task-t1" };
const morning: PushPayload = { kind: "morning", title: "Today", body: "3 reminders", count: 3, tag: "morning" };
const held: PushPayload = { kind: "held", title: "Held", body: "2 reminders", count: 2, tag: "held" };
const test: PushPayload = { kind: "test", title: "VEMI", body: "Reminders work here", tag: "test" };

describe("a push payload on this device", () => {
  it("opens a task over the page, and everything else opens Today", () => {
    expect(openUrlFor(task)).toBe("/?task=t1");
    expect(openUrlFor(morning)).toBe("/today");
    expect(openUrlFor(held)).toBe("/today");
    expect(openUrlFor(test)).toBe("/today");
  });

  it("gives the banner only a task reminder that has its time", () => {
    expect(inAppFor(task)).toEqual({ taskId: "t1", at: "2026-11-18T09:30" });
    expect(inAppFor({ ...task, at: undefined } as unknown as PushPayload)).toBeNull();
    expect(inAppFor(morning)).toBeNull();
  });

  it("adds Done and In 1 hour as far as the device allows", () => {
    const titles = (n: number) => notificationFor(task, n).options.actions.map((a) => a.title);
    expect(titles(2)).toEqual(["Done", "In 1 hour"]);
    expect(titles(5)).toEqual(["Done", "In 1 hour"]);
    expect(titles(1)).toEqual(["Done"]);
    expect(titles(0)).toEqual([]);
    expect(notificationFor(morning, 2).options.actions).toEqual([]);
  });

  it("keeps title, body and tag, and carries what a tap needs", () => {
    const plan = notificationFor(task, 2);
    expect(plan.title).toBe("Ring the plumber");
    expect(plan.options).toMatchObject({ body: "Due now", tag: "task-t1", data: { kind: "task", url: "/?task=t1", taskId: "t1", at: "2026-11-18T09:30" } });
  });

  it("builds the body of an act only for a known action on a task", () => {
    const data = notificationFor(task, 2).options.data;
    expect(actBody(data, "done")).toEqual({ taskId: "t1", action: "done", at: "2026-11-18T09:30" });
    expect(actBody(data, "snooze")).toEqual({ taskId: "t1", action: "snooze", at: "2026-11-18T09:30" });
    expect(actBody(data, "other")).toBeNull();
    expect(actBody(notificationFor(morning, 2).options.data, "done")).toBeNull();
  });
});

describe("the page listening to the worker", () => {
  function from() {
    let fn: ((e: MessageEvent) => void) | undefined;
    return {
      target: {
        addEventListener: (_t: "message", l: (e: MessageEvent) => void) => { fn = l; },
        removeEventListener: () => { fn = undefined; },
      },
      send: (data: unknown) => fn?.({ data } as MessageEvent),
      listening: () => fn !== undefined,
    };
  }

  it("shows a pushed reminder, opens a path it is told to, and ignores the rest", () => {
    const f = from();
    const shown: unknown[] = [];
    const opened: string[] = [];
    const stop = listenForPush(f.target, { show: (r) => shown.push(r), open: (u) => opened.push(u) });
    f.send({ type: PUSH_MESSAGE, payload: task });
    f.send({ type: PUSH_MESSAGE, payload: morning });
    f.send({ type: OPEN_MESSAGE, url: "/today" });
    f.send({ type: OPEN_MESSAGE, url: "https://elsewhere.test/" });
    f.send("forget-data");
    f.send(null);
    expect(shown).toEqual([{ taskId: "t1", at: "2026-11-18T09:30" }]);
    expect(opened).toEqual(["/today"]);
    stop();
    expect(f.listening()).toBe(false);
  });
});

/** Runs the real worker and checks its twin of the mapping gives the same answers. */
describe("the service worker's twin of the mapping", () => {
  type Listener = (event: unknown) => void;
  const source = readFileSync(new URL("./sw.js", import.meta.url), "utf8");

  function load(windows: { visibilityState: string; postMessage: (m: unknown) => void; focus?: () => Promise<void> }[], maxActions: number) {
    const listeners = new Map<string, Listener>();
    const shown: { title: string; options: unknown }[] = [];
    const opened: string[] = [];
    const posted: unknown[] = [];
    const context = {
      self: {
        addEventListener: (type: string, fn: Listener) => listeners.set(type, fn),
        location: { origin: "https://vemi.test" },
        registration: { showNotification: (title: string, options: unknown) => { shown.push({ title, options }); return Promise.resolve(); } },
        clients: { matchAll: () => Promise.resolve(windows), openWindow: (u: string) => { opened.push(u); return Promise.resolve(); } },
      },
      Notification: Object.assign(function Notification() { /* the constructor is not called */ }, { maxActions }),
      caches: {}, fetch: (url: string, init: { body: string }) => { posted.push({ url, body: JSON.parse(init.body) }); return Promise.resolve({ ok: true }); },
      Request, Response, Headers, URL, Date, Promise, JSON, Array, Math, encodeURIComponent, setTimeout, clearTimeout,
    };
    runInNewContext(source, context);
    return { listeners, shown, opened, posted };
  }

  const push = (l: Map<string, Listener>, payload: PushPayload) => {
    let done: Promise<unknown> = Promise.resolve();
    l.get("push")?.({ data: { json: () => payload }, waitUntil: (p: Promise<unknown>) => { done = p; } });
    return done;
  };

  it("shows what the mapping says when no tab is on screen", async () => {
    const w = load([], 2);
    await push(w.listeners, task);
    expect(JSON.parse(JSON.stringify(w.shown))).toEqual(JSON.parse(JSON.stringify([notificationFor(task, 2)])));
    await push(w.listeners, morning);
    expect(JSON.parse(JSON.stringify(w.shown[1]))).toEqual(JSON.parse(JSON.stringify(notificationFor(morning, 2))));
  });

  it("sends a task reminder to a visible tab and shows no system notification", async () => {
    const got: unknown[] = [];
    const w = load([{ visibilityState: "visible", postMessage: (m) => got.push(m) }], 2);
    await push(w.listeners, task);
    expect(w.shown).toEqual([]);
    expect(got).toEqual([{ type: PUSH_MESSAGE, payload: task }]);
    await push(w.listeners, morning);
    expect(w.shown.length).toBe(1);
  });

  async function click(w: ReturnType<typeof load>, action: string) {
    let done: Promise<unknown> = Promise.resolve();
    w.listeners.get("notificationclick")?.({
      action,
      notification: { data: notificationFor(task, 2).options.data, close: () => undefined },
      waitUntil: (p: Promise<unknown>) => { done = p; },
    });
    await done;
  }

  it("posts Done and In 1 hour to the act route and opens nothing", async () => {
    const w = load([], 2);
    await click(w, "done");
    await click(w, "snooze");
    expect(w.posted).toEqual([
      { url: "/api/push/act", body: { taskId: "t1", action: "done", at: "2026-11-18T09:30" } },
      { url: "/api/push/act", body: { taskId: "t1", action: "snooze", at: "2026-11-18T09:30" } },
    ]);
    expect(w.opened).toEqual([]);
  });

  it("focuses an open tab and tells it where to go, else opens a window", async () => {
    const got: unknown[] = [];
    const focused: string[] = [];
    const tab = { visibilityState: "hidden", postMessage: (m: unknown) => got.push(m), focus: () => { focused.push("yes"); return Promise.resolve(); } };
    const open = load([tab], 2);
    await click(open, "");
    expect(focused).toEqual(["yes"]);
    expect(got).toEqual([{ type: OPEN_MESSAGE, url: "/?task=t1" }]);
    const none = load([], 2);
    await click(none, "");
    expect(none.opened).toEqual(["/?task=t1"]);
  });
});

/**
 * A reminder from an account with full encryption. The real worker finds the device key in a
 * fake IndexedDB (`vemi-keys`, store `keys`), opens the task's own title envelope and shows it.
 * `encryptedReminders.test.ts` in the API is the twin that builds these messages.
 */
describe("the service worker and a sealed title", () => {
  type Listener = (event: unknown) => void;
  const source = readFileSync(new URL("./sw.js", import.meta.url), "utf8");
  const GENERIC = "You have a reminder";
  const REF = "AAAAAAAAAAA";

  type Entry = { fieldKey?: CryptoKey; keyRef: string; deviceId: string };

  /** An IndexedDB with one database, `vemi-keys`, whose `keys` store holds `entries`; null: it cannot be opened. */
  function fakeIndexedDb(entries: Entry[] | null) {
    return {
      open: () => {
        const request: { result?: unknown; error?: unknown; onsuccess?: () => void; onerror?: () => void } = {};
        queueMicrotask(() => {
          if (entries === null) {
            request.error = new Error("no");
            request.onerror?.();
            return;
          }
          request.result = {
            close: () => undefined,
            transaction: () => ({
              objectStore: () => ({
                getAll: () => {
                  const all: { result?: unknown; onsuccess?: () => void } = {};
                  queueMicrotask(() => {
                    all.result = entries;
                    all.onsuccess?.();
                  });
                  return all;
                },
              }),
            }),
          };
          request.onsuccess?.();
        });
        return request;
      },
    };
  }

  function load(entries: Entry[] | null) {
    const listeners = new Map<string, Listener>();
    const shown: { title: string; options: { body: string; data: Record<string, unknown> } }[] = [];
    const context = {
      self: {
        addEventListener: (type: string, fn: Listener) => listeners.set(type, fn),
        location: { origin: "https://vemi.test" },
        registration: { showNotification: (title: string, options: never) => { shown.push({ title, options }); return Promise.resolve(); } },
        clients: { matchAll: () => Promise.resolve([]), openWindow: () => Promise.resolve() },
      },
      Notification: Object.assign(function Notification() { /* not called */ }, { maxActions: 2 }),
      caches: {}, fetch: () => Promise.resolve({ ok: true }), indexedDB: fakeIndexedDb(entries),
      crypto, TextEncoder, TextDecoder, atob, Uint8Array,
      Request, Response, Headers, URL, Date, Promise, JSON, Array, Math, encodeURIComponent, setTimeout, clearTimeout,
    };
    runInNewContext(source, context);
    const push = async (payload: PushPayload) => {
      let done: Promise<unknown> = Promise.resolve();
      listeners.get("push")?.({ data: { json: () => payload }, waitUntil: (p: Promise<unknown>) => { done = p; } });
      await done;
    };
    return { shown, push };
  }

  async function sealed() {
    const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
    const envelope = await seal(key, REF, "Ring the plumber about the leak", { record: "t1", field: "title" });
    const entries: Entry[] = [{ keyRef: "other-ref-xx", deviceId: "d0" }, { fieldKey: key, keyRef: REF, deviceId: "d1" }];
    return { key, envelope, entries };
  }

  const taskPush = (sealedTitle: string): PushPayload => ({
    kind: "task", title: GENERIC, body: "", taskId: "t1", at: "2026-11-18T09:30", tag: "task-t1", sealedTitle,
  });
  const heldPush = (sealedTitle: string): PushPayload => ({
    kind: "held", title: "2 reminders", body: "", taskId: "t1", count: 2, tag: "held", sealedTitle,
  });
  const morningPush = (sealedTitle: string): PushPayload => ({
    kind: "morning", title: "3 on today", body: "", taskId: "t1", count: 3, tag: "morning", sealedTitle,
  });

  it("opens the title with the key whose ref matches, and shows it", async () => {
    const { envelope, entries } = await sealed();
    const w = load(entries);
    await w.push(taskPush(envelope));
    await w.push(heldPush(envelope));
    await w.push(morningPush(envelope));
    expect(w.shown.map((s) => [s.title, s.options.body])).toEqual([
      ["Ring the plumber about the leak", ""],
      ["2 reminders", "Ring the plumber about the leak"],
      ["3 on today", "Ring the plumber about the leak"],
    ]);
    // The twin in `pushMessage.ts` agrees, the actions are unchanged, and the envelope is not shown.
    expect(JSON.parse(JSON.stringify(w.shown[0]))).toEqual(
      JSON.parse(JSON.stringify(notificationFor(shownPayload(taskPush(envelope), "Ring the plumber about the leak"), 2))),
    );
    expect(JSON.stringify(w.shown)).not.toContain(envelope);
    expect(w.shown[0]?.options).toMatchObject({ actions: [{ action: "done" }, { action: "snooze" }] });
  });

  it("shows the generic title, or the count line only, with no key on this device", async () => {
    const { envelope } = await sealed();
    for (const entries of [[], [{ keyRef: "other-ref-xx", deviceId: "d0" }] as Entry[], null]) {
      const w = load(entries);
      await w.push(taskPush(envelope));
      await w.push(heldPush(envelope));
      await w.push(morningPush(envelope));
      expect(w.shown.map((s) => [s.title, s.options.body])).toEqual([[GENERIC, ""], ["2 reminders", ""], ["3 on today", ""]]);
      expect(JSON.stringify(w.shown)).not.toContain(envelope);
    }
  });

  it("shows the generic title when the envelope is damaged, or not this task's", async () => {
    const { envelope, entries } = await sealed();
    const parts = envelope.split(".");
    const flipped = `${parts[0]}.${parts[1]}.${parts[2]}.${parts[3]!.replace(/^./, parts[3]![0] === "A" ? "B" : "A")}`;
    for (const bad of [flipped, `${parts[0]}.${parts[1]}.${parts[2]}`, `v2.${parts.slice(1).join(".")}`, "not an envelope"]) {
      const w = load(entries);
      await w.push(taskPush(bad));
      await w.push(morningPush(bad));
      expect(w.shown.map((s) => [s.title, s.options.body])).toEqual([[GENERIC, ""], ["3 on today", ""]]);
    }
    const w = load(entries);
    await w.push({ ...taskPush(envelope), taskId: "t2", tag: "task-t2" });
    expect(w.shown[0]?.title).toBe(GENERIC);
  });

  it("leaves a plain message as it was", async () => {
    const w = load([]);
    await w.push(task);
    expect(JSON.parse(JSON.stringify(w.shown))).toEqual(JSON.parse(JSON.stringify([notificationFor(task, 2)])));
  });
});

describe("shownPayload", () => {
  it("swaps in an opened title, and drops the envelope either way", () => {
    const sealedTitle = `v1.${"a".repeat(11)}.${"b".repeat(16)}.${"c".repeat(40)}`;
    const t = { ...task, title: "You have a reminder", body: "", sealedTitle };
    expect(shownPayload(t, "Real")).toEqual({ ...task, title: "Real", body: "" });
    expect(shownPayload(t, null)).toEqual({ ...task, title: "You have a reminder", body: "" });
    const m = { ...morning, body: "", taskId: "t1", sealedTitle };
    expect(shownPayload(m, "Real")).toEqual({ ...morning, body: "Real", taskId: "t1" });
    expect(shownPayload(m, null)).toEqual({ ...morning, body: "", taskId: "t1" });
  });
});
