import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Change } from "@vemi/shared";
import { createApp, type App } from "./app.js";
import { accountIdentity } from "./accountIdentity.js";
import { hashPassword } from "./password.js";
import { openStore, type Store } from "./store.js";
import { testDb, type TestDb } from "./testing/d1.js";

/** What an app did is kept, listed for 7 days and undoable, through the real routes and a real D1. */

const ORIGIN = "https://vemi.example.workers.dev";
const PASSWORD = "a long enough password";
const START = new Date("2026-11-18T02:00:00Z");
const DAY = 24 * 60 * 60 * 1000;

let now = START;
let t: TestDb;
let store: Store;
let app: App;
let passwordHash: string;
const heard: { owner: string; change: Change }[] = [];

beforeAll(async () => {
  t = await testDb();
  passwordHash = await hashPassword(PASSWORD);
  store = openStore({ DB: t.db }, () => now);
  app = createApp({
    store, now: () => now, origin: ORIGIN, timeZone: "Australia/Sydney",
    identity: accountIdentity({
      store, now: () => now, origin: ORIGIN, owner: "the-operator", operatorEmail: "",
      sessionSecret: "session-secret", google: null,
      fetch: async () => { throw new Error("a test reached the network"); },
    }),
    live: { publish: async (owner, change) => { heard.push({ owner, change }); }, connect: async () => new Response("connected") },
  });
  await store.registerClient({ id: "client-1", name: "Claude", redirectUris: ["https://claude.example/cb"] });
});
afterAll(() => t.dispose());

const sha = async (s: string): Promise<string> =>
  [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)))].map((b) => b.toString(16).padStart(2, "0")).join("");

type View = { id: string; clientName: string; tool: string; kind: string; recordId: string; createdAt: string; undoneAt: string | null };

async function person() {
  now = START;
  const owner = `owner-${crypto.randomUUID()}`;
  const email = `${owner}@example.test`;
  expect(await store.createAccount({ id: owner, email, passwordHash, googleSub: null, confirmed: true })).toBe(true);
  const token = `token-${crypto.randomUUID()}`;
  await store.issueGrant(owner, { clientId: "client-1", tokenHash: await sha(token), refreshHash: await sha(`r-${token}`), expiresAt: "2026-12-30T00:00:00.000Z" });

  let cookie = "";
  const session = (method: string, path: string, body?: unknown) => app(
    new Request(`${ORIGIN}${path}`, {
      method,
      headers: { origin: ORIGIN, ...(cookie ? { cookie } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    () => {},
  );
  const signedIn = await session("POST", "/auth/sign-in", { email, password: PASSWORD });
  expect(signedIn.status).toBe(200);
  cookie = (signedIn.headers.get("set-cookie") ?? "").split(";")[0] ?? "";

  let id = 0;
  const tool = async (name: string, args: Record<string, unknown> = {}) => {
    const res = await app(new Request(`${ORIGIN}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method: "tools/call", params: { name, arguments: args } }),
    }), () => {});
    const body = (await res.json()) as { result: { content: { text: string }[]; isError?: boolean } };
    const text = body.result.content[0]?.text ?? "";
    return body.result.isError === true ? { error: text } : { data: JSON.parse(text) as any };
  };
  const changes = async (): Promise<View[]> =>
    ((await (await session("GET", "/api/connector/changes")).json()) as { changes: View[] }).changes;
  const undo = (changeId: string) => session("POST", `/api/connector/changes/${changeId}/undo`);

  const space = good(await store.create(owner, "ventures", { name: "Workshop" })).record;
  const project = good(await store.create(owner, "projects", { ventureId: space.id, name: "Shed" })).record;
  return { owner, space, project, session, tool, changes, undo };
}

function good<T>(o: { ok: true; value: T } | { ok: false; error: string }): T {
  if (!o.ok) throw new Error(o.error);
  return o.value;
}

const task = async (p: Awaited<ReturnType<typeof person>>, id: string) => (await store.get(p.owner, "tasks", id))!;

describe("recording", () => {
  it("keeps a row for each write tool, with the client's name", async () => {
    const p = await person();
    const added = await p.tool("add_task", { title: "Buy bolts", space: "Workshop" });
    const id = added.data.id as string;
    await p.tool("update_task", { task: id, title: "Buy more bolts" });
    await p.tool("pick_for_today", { task: id });
    await p.tool("complete_task", { task: id });
    await p.tool("add_project", { space: "Workshop", name: "Fence" });
    await p.tool("add_note", { project: "Shed", text: "Measure twice" });
    await p.tool("update_brief", { project: "Shed", field: "whoFor", text: "Me" });
    const rows = await p.changes();
    expect(rows.map((r) => r.tool).sort()).toEqual([
      "add_note", "add_project", "add_task", "complete_task", "pick_for_today", "update_brief", "update_task",
    ]);
    for (const r of rows) {
      expect(r.clientName).toBe("Claude");
      expect(r.undoneAt).toBeNull();
    }
  });

  it("keeps nothing for a read or a refused write", async () => {
    const p = await person();
    await p.tool("overview");
    await p.tool("add_task", { title: "", space: "Workshop" });
    expect(await p.changes()).toEqual([]);
  });

  it("does not hand out the earlier values", async () => {
    const p = await person();
    const id = (await p.tool("add_task", { title: "Secret", space: "Workshop" })).data.id as string;
    await p.tool("update_task", { task: id, title: "Other" });
    const raw = await (await p.session("GET", "/api/connector/changes")).text();
    expect(raw).not.toContain("before");
  });

  it("answers a signed-out person with 401", async () => {
    const r = await app(new Request(`${ORIGIN}/api/connector/changes`), () => {});
    expect(r.status).toBe(401);
  });
});

describe("undo", () => {
  it("restores a task's earlier values and says so live", async () => {
    const p = await person();
    const id = (await p.tool("add_task", { title: "Buy bolts", space: "Workshop" })).data.id as string;
    await p.tool("update_task", { task: id, title: "Buy more bolts", when: "2026-11-25" });
    const update = (await p.changes()).find((r) => r.tool === "update_task")!;
    heard.length = 0;
    const res = await p.undo(update.id);
    expect(res.status).toBe(200);
    const back = await task(p, id);
    expect(back.title).toBe("Buy bolts");
    expect(back.dueOn).toBeNull();
    expect(heard).toContainEqual({ owner: p.owner, change: { kind: "tasks", id, ventureId: p.space.id, via: "connector" } });
    const after = (await p.changes()).find((r) => r.id === update.id)!;
    expect(after.undoneAt).not.toBeNull();
  });

  it("undoes picking for today and finishing", async () => {
    const p = await person();
    const id = (await p.tool("add_task", { title: "Sand", space: "Workshop" })).data.id as string;
    await p.tool("pick_for_today", { task: id });
    await p.tool("complete_task", { task: id });
    const rows = await p.changes();
    const done = rows.find((r) => r.tool === "complete_task")!;
    const picked = rows.find((r) => r.tool === "pick_for_today")!;
    const finishedState = (await task(p, id)).stateId;
    expect((await p.undo(done.id)).status).toBe(200);
    expect((await task(p, id)).stateId).not.toBe(finishedState);
    expect((await p.undo(picked.id)).status).toBe(200);
    expect((await task(p, id)).pickedOn).toBeNull();
  });

  it("restores a project's brief", async () => {
    const p = await person();
    await p.tool("update_brief", { project: "Shed", field: "whoFor", text: "Me" });
    const row = (await p.changes())[0]!;
    expect((await p.undo(row.id)).status).toBe(200);
    expect(good(await store.update(p.owner, "projects", p.project.id, {})).record.whoFor).toBeNull();
  });

  it("archives what was added and never deletes it", async () => {
    const p = await person();
    const id = (await p.tool("add_task", { title: "Oops", space: "Workshop" })).data.id as string;
    const note = (await p.tool("add_note", { project: "Shed", text: "Oops" })).data.id as string;
    const proj = (await p.tool("add_project", { space: "Workshop", name: "Oops" })).data.id as string;
    for (const row of await p.changes()) expect((await p.undo(row.id)).status).toBe(200);
    expect((await task(p, id)).archivedAt).not.toBeNull();
    expect((await store.get(p.owner, "notes", note))!.archivedAt).not.toBeNull();
    expect((await store.get(p.owner, "projects", proj))!.archivedAt).not.toBeNull();
  });

  it("refuses a second undo with a plain line", async () => {
    const p = await person();
    await p.tool("add_task", { title: "Once", space: "Workshop" });
    const row = (await p.changes())[0]!;
    expect((await p.undo(row.id)).status).toBe(200);
    const again = await p.undo(row.id);
    expect(again.status).toBe(409);
    expect(((await again.json()) as { error: string }).error).toBe("that change was already undone");
  });

  it("refuses one older than 7 days, and stops listing it", async () => {
    const p = await person();
    await p.tool("add_task", { title: "Old", space: "Workshop" });
    const row = (await p.changes())[0]!;
    now = new Date(START.getTime() + 6 * DAY);
    expect(await p.changes()).toHaveLength(1);
    now = new Date(START.getTime() + 8 * DAY);
    expect(await p.changes()).toEqual([]);
    const res = await p.undo(row.id);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe("that change is more than 7 days old");
  });

  it("refuses when the person changed the record since", async () => {
    const p = await person();
    const id = (await p.tool("add_task", { title: "Mine", space: "Workshop" })).data.id as string;
    await p.tool("update_task", { task: id, title: "Theirs" });
    const row = (await p.changes()).find((r) => r.tool === "update_task")!;
    now = new Date(START.getTime() + 60_000);
    good(await store.update(p.owner, "tasks", id, { title: "Edited by hand" }));
    const res = await p.undo(row.id);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe("that was changed since, so it was left as it is");
    expect((await task(p, id)).title).toBe("Edited by hand");
  });

  it("asks for the later change to be undone first", async () => {
    const p = await person();
    const id = (await p.tool("add_task", { title: "A", space: "Workshop" })).data.id as string;
    now = new Date(START.getTime() + 1000);
    await p.tool("update_task", { task: id, title: "B" });
    now = new Date(START.getTime() + 2000);
    await p.tool("update_task", { task: id, title: "C" });
    const rows = await p.changes();
    const first = rows.find((r) => r.tool === "update_task" && r.createdAt === new Date(START.getTime() + 1000).toISOString())!;
    const second = rows.find((r) => r.tool === "update_task" && r.createdAt === new Date(START.getTime() + 2000).toISOString())!;
    expect((await p.undo(first.id)).status).toBe(409);
    expect((await p.undo(second.id)).status).toBe(200);
    expect((await task(p, id)).title).toBe("B");
    expect((await p.undo(first.id)).status).toBe(200);
    expect((await task(p, id)).title).toBe("A");
  });

  it("undoes the spawned next task of a repeating one by archiving it", async () => {
    const p = await person();
    const id = (await p.tool("add_task", { title: "Water", space: "Workshop", when: "2026-11-18", repeat: "day" })).data.id as string;
    await p.tool("complete_task", { task: id });
    const rows = await p.changes();
    const spawned = rows.find((r) => r.tool === "complete_task" && r.recordId !== id);
    expect(spawned).toBeDefined();
    expect((await p.undo(spawned!.id)).status).toBe(200);
    expect((await task(p, spawned!.recordId)).archivedAt).not.toBeNull();
  });

  it("answers 404 for a change that is not there", async () => {
    const p = await person();
    expect((await p.undo("nope")).status).toBe(404);
  });
});

describe("one person at a time", () => {
  it("neither lists nor undoes another account's change", async () => {
    const a = await person();
    const b = await person();
    await a.tool("add_task", { title: "Mine", space: "Workshop" });
    const row = (await a.changes())[0]!;
    expect(await b.changes()).toEqual([]);
    const res = await b.undo(row.id);
    expect(res.status).toBe(404);
    const stillThere = (await a.changes())[0]!;
    expect(stillThere.undoneAt).toBeNull();
  });
});
