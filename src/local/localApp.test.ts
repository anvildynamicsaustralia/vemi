import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Change } from "@vemi/shared";
import { PROFILE_DEFAULTS } from "../api/testing/profileDefaults.js";
import { createChannel } from "./channel.js";
import { openLocalApp, type LocalApp } from "./localApp.js";
import { openSqliteEngine } from "./sqliteEngine.js";
import type { SqlEngine } from "./sqlD1.js";

/**
 * The real app on the wasm engine, through `handle`. The fixtures and shapes follow
 * `src/api/app.test.ts` and `accountData.test.ts`, which run the same routes against D1.
 */

const ORIGIN = "https://vemi.test";
type Json = Record<string, any>;

let engine: SqlEngine;
let page: LocalApp;
let published: Change[];
beforeEach(async () => {
  engine = await openSqliteEngine();
  published = [];
  page = await openLocalApp({
    engine, origin: ORIGIN, timeZone: "Australia/Sydney", now: () => new Date("2026-09-14T02:00:00Z"),
    post: (change) => { published.push(change); },
  });
});
afterEach(async () => {
  await page.idle();
  await engine.close();
});

async function call(method: string, path: string, body?: unknown): Promise<{ status: number; json: Json; response: Response }> {
  // A browser drops the Origin header, so none is sent.
  const response = await page.handle(new Request(`${ORIGIN}${path}`, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  }));
  const text = await response.clone().text();
  return { status: response.status, json: text === "" ? {} : JSON.parse(text), response };
}

describe("first open", () => {
  it("makes the account and says signed in, with nothing to sign in with", async () => {
    const me = await call("GET", "/auth/me");
    expect(me.status).toBe(200);
    expect(me.json).toMatchObject({ signedIn: true, id: "local", password: false, google: false, twoStep: false });
    expect((await call("POST", "/auth/sign-in", { email: "a@b.c", password: "x" })).status).toBe(404);
    expect((await call("GET", "/auth/google/start")).status).toBe(404);
  });

  it("answers landing off", async () => {
    const front = await call("GET", "/api/front");
    expect(front.status).toBe(200);
    expect(front.json).toEqual({ landing: false });
  });

  it("keeps the device's time zone and the appearance defaults", async () => {
    const look = await call("GET", "/api/appearance");
    expect(look.json).toEqual({
      accent: "ember", spacing: "comfortable", theme: "system", mapStyle: "grid", newTaskVentureId: null, lastReviewOn: null,
      morningAt: null, taskReminders: false, quietFrom: null, quietTo: null, ...PROFILE_DEFAULTS, timeZone: "Australia/Sydney",
    });
  });
});

describe("the minute's check", () => {
  it("answers what is due now once, and nothing when reminders are off or the page was hidden too long", async () => {
    const space = await call("POST", "/api/ventures", { name: "Farm" });
    const task = await call("POST", "/api/tasks", { ventureId: space.json.id, title: "Water", remindAt: "2026-09-14T11:30" });
    expect((await call("POST", "/api/local/tick", {})).json).toEqual({ due: [] });
    await call("PATCH", "/api/appearance", { taskReminders: true });
    const hidden = await call("POST", "/api/local/tick", { hiddenSince: "2026-09-10T02:00:00Z" });
    expect(hidden.json).toEqual({ due: [] });
    const first = await call("POST", "/api/local/tick", { hiddenSince: "2026-09-14T01:00:00Z" });
    expect(first.json).toEqual({ due: [{ taskId: task.json.id, at: "2026-09-14T11:30" }] });
    expect((await call("POST", "/api/local/tick", {})).json).toEqual({ due: [] });
  });
});

describe("the whole app through handle", () => {
  it("creates a space, project, milestone and task, ticks it, archives and undoes it, searches, reads today, exports and restores", async () => {
    const space = await call("POST", "/api/ventures", { name: "Farm", description: "Ship it" });
    expect(space.status).toBe(201);
    const project = await call("POST", "/api/projects", { ventureId: space.json.id, name: "Fencing" });
    expect(project.status).toBe(201);
    const milestone = await call("POST", "/api/milestones", { projectId: project.json.id, name: "Gate hung" });
    expect(milestone.status).toBe(201);
    const task = await call("POST", "/api/tasks", { ventureId: space.json.id, projectId: project.json.id, milestoneId: milestone.json.id, title: "Check the bore pump" });
    expect(task.status).toBe(201);
    expect(task.json).not.toHaveProperty("icon");
    await page.idle();
    expect(published.at(-1)).toEqual({ kind: "tasks", id: task.json.id, ventureId: space.json.id });

    // Tick: the task moves to the space's finished state.
    const exported = (await call("GET", "/api/export")).json;
    const finished = (exported.tables.state as Json[]).find((s) => s.venture_id === space.json.id && s.kind === "finished");
    expect(finished).toBeDefined();
    const ticked = await call("PATCH", `/api/tasks/${task.json.id}`, { stateId: finished!.id });
    expect(ticked.status).toBe(200);
    expect(ticked.json).toMatchObject({ id: task.json.id, stateId: finished!.id });

    // Archive and undo.
    expect((await call("POST", `/api/tasks/${task.json.id}/archive`)).status).toBe(200);
    expect((await call("GET", `/api/tasks?venture=${space.json.id}`)).json).toEqual([]);
    expect((await call("GET", "/api/archived")).json.items.map((i: Json) => i.id)).toContain(task.json.id);
    expect((await call("POST", `/api/tasks/${task.json.id}/unarchive`)).status).toBe(200);
    expect((await call("GET", `/api/tasks?venture=${space.json.id}`)).json.map((r: Json) => r.id)).toEqual([task.json.id]);

    // Search and today.
    const found = await call("GET", "/api/search?q=farm");
    expect(found.json.results).toEqual([expect.objectContaining({ kind: "venture", text: "Farm" })]);
    const today = await call("GET", "/api/today");
    expect(today.status).toBe(200);
    expect(Array.isArray(today.json.tasks)).toBe(true);
    expect((await call("GET", "/api/overview")).status).toBe(200);
    expect((await call("GET", "/api/tree")).status).toBe(200);

    // Export, with its file name from the device's day, and restore from it.
    const file = await call("GET", "/api/export");
    expect(file.response.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(file.response.headers.get("content-disposition")).toBe('attachment; filename="vemi-export-2026-09-14.json"');
    expect(file.json.format).toBe("vemi-export");
    expect(file.json.tables.venture.map((r: Json) => r.id)).toContain(space.json.id);
    const asked = await call("POST", "/api/restore", { document: file.json });
    expect(asked.json).toMatchObject({ restored: false, confirm: "replace" });
    const done = await call("POST", "/api/restore", { document: file.json, confirm: "replace" });
    expect(done.status).toBe(200);
    expect(done.json.restored).toBe(true);
    const after = (await call("GET", "/api/export")).json;
    expect(after.tables.task).toHaveLength(file.json.tables.task.length);
    expect(after.tables.venture.map((r: Json) => r.name)).toContain("Farm");
  });

  it("refuses what the app refuses, with the same words", async () => {
    expect((await call("POST", "/api/tasks", { title: "no space" })).status).toBe(400);
    expect((await call("GET", "/api/nowhere")).status).toBe(404);
    expect((await call("GET", "/nowhere")).status).toBe(404);
    expect((await call("GET", "/api/live")).status).toBe(426);
  });

  it("hardens every response", async () => {
    const response = (await call("GET", "/api/overview")).response;
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("turns full encryption on and off, the same code as on the Worker", async () => {
    expect((await call("GET", "/api/encryption")).json).toMatchObject({ state: "off", sealed: 0 });
    expect((await call("POST", "/api/encryption/start", { to: "on" })).json.state).toBe("turning_on");
    expect((await call("POST", "/api/encryption/finish")).json.state).toBe("on");
    expect((await call("GET", "/api/appearance")).json.encryption).toBe("on");
    expect((await call("POST", "/api/encryption/start", { to: "off" })).json.state).toBe("turning_off");
    expect((await call("POST", "/api/encryption/finish")).json.state).toBe("off");
  });

  it("answers a write with no Origin header, as a page's own writes arrive", async () => {
    const response = await page.handle(new Request(`${ORIGIN}/api/ventures`, {
      method: "POST", headers: { "content-type": "application/json", origin: "https://elsewhere.test" }, body: '{"name":"Page"}',
    }));
    expect(response.status).toBe(201);
  });
});

describe("the live channel", () => {
  it("posts each change to the channel, and another page listening hears it", async () => {
    const name = `vemi-test-${crypto.randomUUID()}`;
    const mine = createChannel(name);
    const theirs = createChannel(name);
    const heard: Change[] = [];
    const arrived = new Promise<void>((resolve) => theirs.listen((change) => { heard.push(change); resolve(); }));
    const other = await openLocalApp({ engine: await openSqliteEngine(), origin: ORIGIN, timeZone: "UTC", post: (change) => mine.post(change) });
    const made = await other.handle(new Request(`${ORIGIN}/api/ventures`, {
      method: "POST", headers: { "content-type": "application/json" }, body: '{"name":"Shared"}',
    }));
    const space = await made.json() as Json;
    await arrived;
    expect(heard[0]).toMatchObject({ kind: "ventures", id: space.id });
    await other.idle();
    mine.close();
    theirs.close();
  });
});
