import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Change } from "@vemi/shared";
import { createApp } from "./app.js";
import { accountIdentity } from "./accountIdentity.js";
import { hashPassword } from "./password.js";
import { openStore, type Outcome, type Store } from "./store.js";
import { testDb, type TestDb } from "./testing/d1.js";

/**
 * Recurrence on finish. A PATCH that moves an unfinished repeating task into a finished
 * state creates the next task in the same call and answers it as `spawned`. Anything else
 * spawns nothing.
 */

const PASSWORD = "a long enough password";
const NOW = new Date("2026-11-17T02:00:00Z");
const TODAY = "2026-11-17";

function must<V>(outcome: Outcome<V>): V {
  if (!outcome.ok) throw new Error(`${outcome.status}: ${outcome.error}`);
  return outcome.value;
}

let t: TestDb;
let store: Store;
let passwordHash: string;

beforeAll(async () => {
  t = await testDb();
  store = openStore({ DB: t.db }, () => NOW);
  passwordHash = await hashPassword(PASSWORD);
});
afterAll(() => t.dispose());

interface World {
  readonly owner: string;
  readonly venture: string;
  readonly notStarted: string;
  readonly underway: string;
  readonly finished: string;
}

async function world(): Promise<World> {
  const owner = `owner-${crypto.randomUUID()}`;
  expect(await store.createAccount({ id: owner, email: `${owner}@example.test`, passwordHash, googleSub: null, confirmed: true })).toBe(true);
  const venture = must(await store.create(owner, "ventures", { id: crypto.randomUUID(), name: "Space" })).record.id;
  const states = must(await store.list(owner, "states", { venture }));
  const of = (kind: string) => states.find((s) => s.kind === kind)!.id;
  return { owner, venture, notStarted: of("not_started"), underway: of("underway"), finished: of("finished") };
}

async function task(w: World, fields: Record<string, unknown> = {}) {
  const id = `task-${crypto.randomUUID()}`;
  return must(await store.create(w.owner, "tasks", { id, ventureId: w.venture, title: "Water plants", ...fields } as never)).record;
}

const tasksOf = async (w: World) => (await store.tree(w.owner)).ventures.find((v) => v.id === w.venture)!.tasks;

describe("finishing a repeating task", () => {
  it("creates the next task in the same call and returns it as spawned", async () => {
    const w = await world();
    const tag = must(await store.create(w.owner, "tags", { name: "home" } as never)).record.id;
    const made = await task(w, {
      stateId: w.underway, dueOn: "2026-11-17", pickedOn: "2026-11-17", priority: "high",
      remindAt: "2026-11-17T09:30", repeat: "day", checklist: [{ id: "c", text: "step", done: false }], tagIds: [tag],
    });
    const done = must(await store.update(w.owner, "tasks", made.id, { stateId: w.finished }, TODAY));
    expect(done.record.stateId).toBe(w.finished);
    const next = done.spawned!;
    expect(next.id).not.toBe(made.id);
    expect([next.title, next.ventureId, next.projectId, next.milestoneId, next.priority, next.repeat])
      .toEqual([made.title, w.venture, made.projectId, made.milestoneId, "high", "day"]);
    expect(next.dueOn).toBe("2026-11-18");
    expect(next.remindAt).toBe("2026-11-18T09:30");
    expect(next.pickedOn).toBeNull();
    expect(next.checklist).toEqual([]);
    expect(next.stateId).toBe(w.notStarted);
    const stored = (await tasksOf(w)).find((x) => x.id === next.id)!;
    expect(stored.tagIds).toEqual([tag]);
    expect((await tasksOf(w)).filter((x) => x.title === "Water plants")).toHaveLength(2);
  });

  it("files the next one after today when it was finished late, or had no due date", async () => {
    const w = await world();
    const late = await task(w, { dueOn: "2026-11-01", repeat: "week:1" });
    expect(must(await store.update(w.owner, "tasks", late.id, { stateId: w.finished }, TODAY)).spawned!.dueOn).toBe("2026-11-23");
    const open = await task(w, { repeat: "month" });
    expect(must(await store.update(w.owner, "tasks", open.id, { stateId: w.finished }, TODAY)).spawned!.dueOn).toBe("2026-12-17");
  });

  it("spawns nothing without a repeat, or when the patch does not finish it", async () => {
    const w = await world();
    const plain = await task(w);
    expect(must(await store.update(w.owner, "tasks", plain.id, { stateId: w.finished }, TODAY)).spawned).toBeUndefined();
    const repeating = await task(w, { repeat: "day" });
    expect(must(await store.update(w.owner, "tasks", repeating.id, { title: "Renamed" }, TODAY)).spawned).toBeUndefined();
    expect(must(await store.update(w.owner, "tasks", repeating.id, { stateId: w.underway }, TODAY)).spawned).toBeUndefined();
    expect(await tasksOf(w)).toHaveLength(2);
  });

  it("spawns once when the task is finished twice in a row", async () => {
    const w = await world();
    const made = await task(w, { repeat: "day" });
    expect(must(await store.update(w.owner, "tasks", made.id, { stateId: w.finished }, TODAY)).spawned).toBeDefined();
    expect(must(await store.update(w.owner, "tasks", made.id, { stateId: w.finished }, TODAY)).spawned).toBeUndefined();
    expect(await tasksOf(w)).toHaveLength(2);
  });

  it("does not fail the patch when the stored repeat does not parse", async () => {
    const w = await world();
    const made = await task(w, { repeat: "day" });
    await t.db.prepare(`UPDATE task SET repeat = 'fortnightly' WHERE id = ?`).bind(made.id).run();
    const done = must(await store.update(w.owner, "tasks", made.id, { stateId: w.finished }, TODAY));
    expect(done.record.stateId).toBe(w.finished);
    expect(done.spawned).toBeUndefined();
    expect(await tasksOf(w)).toHaveLength(1);
  });

  it("never spawns into another owner's data", async () => {
    const a = await world();
    const b = await world();
    const made = await task(a, { repeat: "day" });
    const refused = await store.update(b.owner, "tasks", made.id, { stateId: b.finished }, TODAY);
    expect(refused.ok).toBe(false);
    expect(await tasksOf(a)).toHaveLength(1);
    expect(await tasksOf(b)).toHaveLength(0);
  });

  it("spawns nothing when the patch is refused", async () => {
    const a = await world();
    const b = await world();
    const made = await task(a, { repeat: "day" });
    const refused = await store.update(a.owner, "tasks", made.id, { stateId: b.finished }, TODAY);
    expect(refused.ok).toBe(false);
    expect(await tasksOf(a)).toHaveLength(1);
  });
});

describe("the route", () => {
  const ORIGIN = "https://vemi.example.workers.dev";

  async function signedIn() {
    const w = await world();
    const published: Change[] = [];
    const behind: Promise<unknown>[] = [];
    const app = createApp({
      store, now: () => NOW, origin: ORIGIN, timeZone: "Australia/Sydney",
      identity: accountIdentity({
        store, now: () => NOW, origin: ORIGIN, owner: "the-operator", operatorEmail: "", sessionSecret: "session-secret",
        google: null, fetch: async () => { throw new Error("a test reached the network"); },
      }),
      live: { publish: async (_o, c) => { published.push(c); }, connect: async () => new Response("connected") },
    });
    let cookie = "";
    const call = (method: string, path: string, body?: unknown) => app(
      new Request(`${ORIGIN}${path}`, {
        method,
        headers: { origin: ORIGIN, ...(cookie ? { cookie } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }) },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
      (work) => { behind.push(work); },
    );
    const response = await call("POST", "/auth/sign-in", { email: `${w.owner}@example.test`, password: PASSWORD });
    expect(response.status).toBe(200);
    cookie = (response.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    const settle = async () => { while (behind.length > 0) await Promise.all(behind.splice(0)); };
    return { w, call, published, settle };
  }

  it("answers the task with spawned beside it, due in the request's zone, and publishes both", async () => {
    const { w, call, published, settle } = await signedIn();
    const made = await task(w, { repeat: "day", dueOn: "2026-11-10" });
    await settle();
    published.length = 0;
    // 02:00 UTC is 13:00 on the 17th in Sydney and 21:00 on the 16th in New York.
    const response = await call("PATCH", `/api/tasks/${made.id}?tz=America/New_York`, { stateId: w.finished });
    expect(response.status).toBe(200);
    const answer = await response.json() as { id: string; stateId: string; spawned: { id: string; dueOn: string } };
    expect(answer.id).toBe(made.id);
    expect(answer.stateId).toBe(w.finished);
    expect(answer.spawned.dueOn).toBe("2026-11-17");
    await settle();
    expect(published.map((c) => c.id).sort()).toEqual([made.id, answer.spawned.id].sort());
    const plain = await call("PATCH", `/api/tasks/${made.id}`, { title: "Renamed" });
    expect(Object.keys(await plain.json() as object)).not.toContain("spawned");
  });
});
