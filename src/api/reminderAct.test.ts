import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp, type App } from "./app.js";
import { accountIdentity } from "./accountIdentity.js";
import { hashPassword } from "./password.js";
import { openStore, type Outcome, type Store } from "./store.js";
import { testDb, type TestDb } from "./testing/d1.js";

/**
 * Acting from a notification: POST /api/push/act finishes a task by the same path as a state
 * change (so a repeating task spawns its next), or moves its reminder an hour on. Another
 * account's task and an archived one both answer 404.
 */

const PASSWORD = "a long enough password";
const ORIGIN = "https://vemi.test";
const NOW = new Date("2026-11-17T02:00:00Z");

function must<V>(outcome: Outcome<V>): V {
  if (!outcome.ok) throw new Error(`${outcome.status}: ${outcome.error}`);
  return outcome.value;
}

let t: TestDb;
let store: Store;
let app: App;
let passwordHash: string;

beforeAll(async () => {
  t = await testDb();
  store = openStore({ DB: t.db }, () => NOW);
  passwordHash = await hashPassword(PASSWORD);
  const clock = () => NOW;
  app = createApp({
    store, now: clock, origin: ORIGIN, timeZone: "Australia/Sydney",
    identity: accountIdentity({
      store, now: clock, origin: ORIGIN, owner: "the-operator", operatorEmail: "", sessionSecret: "session-secret",
      google: null, fetch: async () => { throw new Error("a test reached the network"); },
    }),
    live: { publish: async () => {}, connect: async () => new Response("connected") },
  });
});
afterAll(() => t.dispose());

async function account() {
  const owner = `owner-${crypto.randomUUID()}`;
  expect(await store.createAccount({ id: owner, email: `${owner}@example.test`, passwordHash, googleSub: null, confirmed: true })).toBe(true);
  const venture = must(await store.create(owner, "ventures", { id: crypto.randomUUID(), name: "Space" })).record.id;
  const states = must(await store.list(owner, "states", { venture }));
  const finished = states.find((s) => s.kind === "finished")!.id;
  const res = await app(new Request(`${ORIGIN}/auth/sign-in`, {
    method: "POST", headers: { origin: ORIGIN, "content-type": "application/json" },
    body: JSON.stringify({ email: `${owner}@example.test`, password: PASSWORD }),
  }), () => {});
  expect(res.status).toBe(200);
  const cookie = (res.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  return { owner, venture, finished, cookie };
}
type Account = Awaited<ReturnType<typeof account>>;

const act = (a: Account, body: unknown) => app(new Request(`${ORIGIN}/api/push/act`, {
  method: "POST", headers: { origin: ORIGIN, cookie: a.cookie, "content-type": "application/json" }, body: JSON.stringify(body),
}), () => {});

async function task(a: Account, fields: Record<string, unknown> = {}) {
  return must(await store.create(a.owner, "tasks", { id: crypto.randomUUID(), ventureId: a.venture, title: "Water plants", ...fields } as never)).record;
}

describe("POST /api/push/act", () => {
  it("done finishes the task", async () => {
    const a = await account();
    const made = await task(a, { remindAt: "2026-11-17T09:30" });
    const res = await act(a, { taskId: made.id, action: "done", at: "2026-11-17T09:30" });
    expect(res.status).toBe(200);
    expect((await store.get(a.owner, "tasks", made.id))!.stateId).toBe(a.finished);
  });

  it("done on a repeating task spawns the next one", async () => {
    const a = await account();
    const made = await task(a, { remindAt: "2026-11-17T09:30", repeat: "day", dueOn: "2026-11-17" });
    const res = await act(a, { taskId: made.id, action: "done", at: "2026-11-17T09:30" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { spawned?: { remindAt: string; dueOn: string } };
    expect(body.spawned?.remindAt).toBe("2026-11-18T09:30");
    expect(body.spawned?.dueOn).toBe("2026-11-18");
  });

  it("snooze moves the reminder one hour on by wall clock, across midnight too", async () => {
    const a = await account();
    const made = await task(a, { remindAt: "2026-11-17T09:30" });
    expect((await act(a, { taskId: made.id, action: "snooze", at: "2026-11-17T09:30" })).status).toBe(200);
    expect((await store.get(a.owner, "tasks", made.id))!.remindAt).toBe("2026-11-17T10:30");
    const late = await task(a, { remindAt: "2026-11-17T23:30" });
    await act(a, { taskId: late.id, action: "snooze", at: "2026-11-17T23:30" });
    expect((await store.get(a.owner, "tasks", late.id))!.remindAt).toBe("2026-11-18T00:30");
    expect((await store.get(a.owner, "tasks", late.id))!.stateId).not.toBe(a.finished);
  });

  it("answers 404 for another account's task and changes nothing", async () => {
    const a = await account();
    const b = await account();
    const made = await task(a, { remindAt: "2026-11-17T09:30" });
    expect((await act(b, { taskId: made.id, action: "done", at: "2026-11-17T09:30" })).status).toBe(404);
    expect((await act(b, { taskId: made.id, action: "snooze", at: "2026-11-17T09:30" })).status).toBe(404);
    const kept = (await store.get(a.owner, "tasks", made.id))!;
    expect(kept.stateId).not.toBe(a.finished);
    expect(kept.remindAt).toBe("2026-11-17T09:30");
  });

  it("answers 404 for an archived task, and for one that does not exist", async () => {
    const a = await account();
    const made = await task(a, { remindAt: "2026-11-17T09:30" });
    must(await store.setArchived(a.owner, "tasks", made.id, true));
    expect((await act(a, { taskId: made.id, action: "done", at: "2026-11-17T09:30" })).status).toBe(404);
    expect((await act(a, { taskId: made.id, action: "snooze", at: "2026-11-17T09:30" })).status).toBe(404);
    expect((await act(a, { taskId: "no-such-task", action: "done", at: "2026-11-17T09:30" })).status).toBe(404);
  });

  it("refuses a body it does not understand", async () => {
    const a = await account();
    const made = await task(a);
    expect((await act(a, { taskId: made.id, action: "delete", at: "2026-11-17T09:30" })).status).toBe(400);
    expect((await act(a, { taskId: made.id, action: "snooze", at: "soon" })).status).toBe(400);
    expect((await act(a, { action: "done", at: "2026-11-17T09:30" })).status).toBe(400);
    expect((await act(a, { taskId: made.id, action: "done", at: "2026-11-17T09:30", extra: 1 })).status).toBe(400);
  });
});
