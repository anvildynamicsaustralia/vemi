import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { accountIdentity } from "./accountIdentity.js";
import { createApp } from "./app.js";
import { hashPassword } from "./password.js";
import { openStore } from "./store.js";
import { accountPurgeJob } from "./accountPurge.js";
import { testDb, type TestDb } from "./testing/d1.js";

/** Export version 2, restore, and account deletion, through `createApp` and a real D1. */

const ORIGIN = "https://vemi.example.workers.dev";
const PASSWORD = "correct horse battery";
const DAY = 24 * 60 * 60 * 1000;

let t: TestDb;
beforeAll(async () => {
  t = await testDb();
});
afterAll(() => t.dispose());

type Json = Record<string, any>;

function world(copyOwner = `copy-owner-${crypto.randomUUID()}`) {
  let now = new Date("2026-09-14T02:00:00Z");
  const clock = () => now;
  const store = openStore({ DB: t.db }, clock);
  const identity = accountIdentity({
    store, now: clock, origin: ORIGIN, owner: copyOwner, operatorEmail: "", sessionSecret: "session-secret",
    google: null, fetch: (async () => { throw new Error("no network"); }) as typeof fetch,
  });
  const app = createApp({
    store, identity, now: clock, origin: ORIGIN, timeZone: "Australia/Sydney", copyOwner,
    live: { publish: async () => {}, connect: async () => new Response("connected") },
  });
  let devices = 0;
  /** A person with an account made in the store, signed in on their own device. */
  async function person(id: string = crypto.randomUUID()) {
    const email = `p-${crypto.randomUUID()}@example.com`;
    expect(await store.createAccount({ id, email, passwordHash: await hashPassword(PASSWORD), googleSub: null, confirmed: true })).toBe(true);
    const jar = new Map<string, string>();
    const ip = `10.9.${++devices}.${Math.floor(Math.random() * 250)}`;
    const send = async (method: string, path: string, body?: unknown): Promise<{ status: number; json: Json }> => {
      const response = await app(new Request(`${ORIGIN}${path}`, {
        method,
        headers: {
          origin: ORIGIN, "cf-connecting-ip": ip,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
          ...(jar.size > 0 ? { cookie: [...jar].map(([k, v]) => `${k}=${v}`).join("; ") } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      }), () => {});
      for (const line of response.headers.getSetCookie()) {
        const [pair = ""] = line.split(";");
        const at = pair.indexOf("=");
        const value = pair.slice(at + 1);
        if (/Max-Age=0/i.test(line) || value === "") jar.delete(pair.slice(0, at));
        else jar.set(pair.slice(0, at), value);
      }
      return { status: response.status, json: (await response.json()) as Json };
    };
    expect((await send("POST", "/auth/sign-in", { email, password: PASSWORD })).status).toBe(200);
    return { id, email, get: (p: string) => send("GET", p), post: (p: string, b: unknown = {}) => send("POST", p, b), patch: (p: string, b: unknown) => send("PATCH", p, b) };
  }
  return { store, person, advance: (ms: number) => { now = new Date(now.getTime() + ms); }, now: () => now, copyOwner };
}

type Person = Awaited<ReturnType<ReturnType<typeof world>["person"]>>;

/** A small map: two spaces (one nested), projects, milestone, tasks, a blocker, notes, tags, a decision and a canvas position. */
async function build(p: Person, label: string) {
  const space = (await p.post("/api/ventures", { name: `${label} space` })).json;
  const child = (await p.post("/api/ventures", { name: `${label} child`, parentId: space.id })).json;
  const project = (await p.post("/api/projects", { ventureId: space.id, name: `${label} project` })).json;
  const milestone = (await p.post("/api/milestones", { projectId: project.id, name: `${label} milestone` })).json;
  const first = (await p.post("/api/tasks", { ventureId: space.id, projectId: project.id, milestoneId: milestone.id, title: `${label} first` })).json;
  const second = (await p.post("/api/tasks", { ventureId: space.id, title: `${label} second` })).json;
  expect(space.id && child.id && project.id && milestone.id && first.id && second.id).toBeTruthy();
  await p.post("/api/blockers", { taskId: second.id, reason: "waiting", waitsOnTaskId: first.id });
  await p.post("/api/notes", { ventureId: space.id, body: `${label} note` });
  await p.post("/api/decisions", { ventureId: space.id, title: `${label} decision` });
  const tag = (await p.post("/api/tags", { name: `${label}-tag` })).json;
  expect((await p.patch("/api/tasks/" + first.id, { tagIds: [tag.id] })).status).toBe(200);
  expect((await p.patch("/api/appearance", { accent: "ocean", levelNames: { space: "Place" }, newTaskVentureId: space.id })).status).toBe(200);
  return { space, child, project, milestone, first, second };
}

const counts = (tables: Record<string, unknown[]>) => Object.fromEntries(Object.entries(tables).map(([k, v]) => [k, v.length]));

describe("export version 2", () => {
  it("is version 2 and carries the account's settings", async () => {
    const w = world();
    const p = await person(w);
    await build(p, "Alpha");
    const doc = (await p.get("/api/export")).json;
    expect(doc.version).toBe(2);
    expect(doc.settings).toMatchObject({ accent: "ocean", levelNames: { space: "Place" } });
    expect(JSON.stringify(doc)).not.toContain(p.email);
  });
});

const person = (w: ReturnType<typeof world>) => w.person();

describe("restore", () => {
  it("answers counts without the word and changes nothing", async () => {
    const w = world();
    const p = await person(w);
    await build(p, "Alpha");
    const doc = (await p.get("/api/export")).json;
    const before = (await p.get("/api/export")).json.tables;
    const answer = await p.post("/api/restore", { document: doc });
    expect(answer.status).toBe(200);
    expect(answer.json).toMatchObject({ restored: false, confirm: "replace" });
    expect(answer.json.counts).toEqual(counts(doc.tables));
    expect((await p.get("/api/export")).json.tables).toEqual(before);
  });

  it("refuses a wrong word, a file that is not an export, and an unknown table", async () => {
    const w = world();
    const p = await person(w);
    const doc = (await p.get("/api/export")).json;
    expect((await p.post("/api/restore", { document: doc, confirm: "yes" })).status).toBe(400);
    expect((await p.post("/api/restore", { document: { format: "other", version: 2, tables: {} }, confirm: "replace" })).status).toBe(400);
    expect((await p.post("/api/restore", { document: { ...doc, version: 3 }, confirm: "replace" })).status).toBe(400);
    const unknown = await p.post("/api/restore", { document: { ...doc, tables: { ...doc.tables, secrets: [{ id: "x" }] } }, confirm: "replace" });
    expect(unknown.status).toBe(400);
  });

  it("never lets a file write the copy's own settings and keys through a restore", async () => {
    const w = world();
    const p = await person(w);
    const key = await w.store.keepSessionKey("kept-session-key");
    await w.store.setFrontLanding(true);
    const doc = (await p.get("/api/export")).json;
    const crafted = (table: string, row: Record<string, unknown>) =>
      p.post("/api/restore", { document: { ...doc, tables: { ...doc.tables, [table]: [row] } }, confirm: "replace" });
    for (const id of [1, "1", "x"]) {
      for (const [table, row] of [
        ["front_setting", { landing: 0, created_at: "2026-01-01T00:00:00Z" }],
        ["session_key", { secret: "chosen-by-the-file", created_at: "2026-01-01T00:00:00Z" }],
        ["vapid_key", { public_key: "x", private_key: "y", created_at: "2026-01-01T00:00:00Z" }],
      ] as const) {
        expect((await crafted(table, { id, ...row })).status, `${table} ${String(id)}`).toBe(400);
      }
    }
    expect(await w.store.frontLanding()).toBe(true);
    expect(await w.store.sessionKey()).toBe(key);
  });

  it("never lets a file's own owner column put rows in another account", async () => {
    const w = world();
    const a = await person(w);
    await build(a, "Alpha");
    const b = await person(w);
    const aBefore = (await a.get("/api/export")).json.tables;
    const crafted = structuredClone((await a.get("/api/export")).json);
    // The file claims every row belongs to account A, and restores into B.
    for (const rows of Object.values(crafted.tables) as Json[][]) for (const row of rows) row.owner = a.id;
    const done = await b.post("/api/restore", { document: crafted, confirm: "replace" });
    // The column is not the file's to set: the rows land in the account that restored, and only there.
    expect(done.status).toBe(200);
    expect((await a.get("/api/export")).json.tables).toEqual(aBefore);
    expect(counts((await b.get("/api/export")).json.tables)).toEqual(counts(crafted.tables));
    expect(await t.db.prepare(`SELECT count(*) AS n FROM venture WHERE owner = ?`).bind(a.id).first<{ n: number }>())
      .toEqual({ n: aBefore.venture.length });
  });

  it("round trips into a fresh account with equal counts, new ids and every reference following", async () => {
    const w = world();
    const a = await person(w);
    const ids = await build(a, "Alpha");
    const doc = (await a.get("/api/export")).json;

    const b = await person(w);
    const done = await b.post("/api/restore", { document: doc, confirm: "replace" });
    expect(done.status).toBe(200);
    expect(done.json.restored).toBe(true);
    const copy = (await b.get("/api/export")).json;
    expect(counts(copy.tables)).toEqual(counts(doc.tables));

    // No id is shared with the account it came from.
    const old = new Set(Object.values(doc.tables).flatMap((rows) => (rows as Json[]).map((r) => r.id)));
    for (const rows of Object.values(copy.tables) as Json[][]) for (const r of rows) if (r.id !== undefined) expect(old.has(r.id)).toBe(false);

    // References follow: the nested space, the project's space, the tasks' project and milestone, the blocker.
    const byName = <T extends Json>(table: string, name: string) => (copy.tables[table] as T[]).find((r) => r.name === name || r.title === name)!;
    const space = byName("venture", "Alpha space");
    const child = byName("venture", "Alpha child");
    expect(child.parent_id).toBe(space.id);
    const project = byName("project", "Alpha project");
    expect(project.venture_id).toBe(space.id);
    const milestone = byName("milestone", "Alpha milestone");
    expect(milestone.project_id).toBe(project.id);
    const first = byName("task", "Alpha first");
    expect(first).toMatchObject({ venture_id: space.id, project_id: project.id, milestone_id: milestone.id });
    const second = byName("task", "Alpha second");
    const blocker = (copy.tables.blocker as Json[])[0]!;
    expect(blocker).toMatchObject({ task_id: second.id, waits_on_task_id: first.id });
    expect((copy.tables.state as Json[]).every((s) => s.venture_id === space.id || s.venture_id === child.id)).toBe(true);
    expect(copy.tables.task_tag).toHaveLength(1);
    expect((copy.tables.task_tag as Json[])[0]!.task_id).toBe(first.id);

    // The settings came across, and the space new tasks go to is the copy's own.
    const settings = (await b.get("/api/appearance")).json;
    expect(settings).toMatchObject({ accent: "ocean", levelNames: { space: "Place" }, newTaskVentureId: space.id });

    // The source account is untouched.
    expect((await a.get("/api/export")).json.tables).toEqual(doc.tables);
    expect(ids.space.id).not.toBe(space.id);
  });

  it("replaces what the account had, and a second restore of the same file lands again with new ids", async () => {
    const w = world();
    const a = await person(w);
    await build(a, "Alpha");
    const doc = (await a.get("/api/export")).json;
    const b = await person(w);
    await build(b, "Beta");
    expect((await b.post("/api/restore", { document: doc, confirm: "replace" })).status).toBe(200);
    const once = (await b.get("/api/export")).json;
    expect(JSON.stringify(once.tables)).not.toContain("Beta");
    expect((await b.post("/api/restore", { document: doc, confirm: "replace" })).status).toBe(200);
    const twice = (await b.get("/api/export")).json;
    expect(counts(twice.tables)).toEqual(counts(doc.tables));
    expect(twice.tables.venture.map((r: Json) => r.id).sort()).not.toEqual(once.tables.venture.map((r: Json) => r.id).sort());
  });

  it("reads a version 1 file, with no settings, and keeps the account's own", async () => {
    const w = world();
    const a = await person(w);
    await build(a, "Alpha");
    const { settings: _settings, ...rest } = (await a.get("/api/export")).json;
    const b = await person(w);
    expect((await b.patch("/api/appearance", { accent: "moss" })).status).toBe(200);
    const done = await b.post("/api/restore", { document: { ...rest, version: 1 }, confirm: "replace" });
    expect(done.status).toBe(200);
    const settings = (await b.get("/api/appearance")).json;
    expect(settings.accent).toBe("moss");
    expect(settings.newTaskVentureId).toBeNull();
    expect(((await b.get("/api/export")).json.tables.venture as Json[]).length).toBe(rest.tables.venture.length);
  });

  it("changes nothing when the file does not fit", async () => {
    const w = world();
    const a = await person(w);
    await build(a, "Alpha");
    const doc = (await a.get("/api/export")).json;
    const b = await person(w);
    await build(b, "Beta");
    const before = (await b.get("/api/export")).json.tables;
    // A task naming a project the file does not hold.
    const broken = structuredClone(doc);
    broken.tables.task[0].project_id = "not-in-the-file";
    const refused = await b.post("/api/restore", { document: broken, confirm: "replace" });
    expect(refused.status).toBe(400);
    // A row the schema refuses (a state kind it does not allow), found only when the batch runs.
    const bad = structuredClone(doc);
    bad.tables.state[0].kind = "nonsense";
    expect((await b.post("/api/restore", { document: bad, confirm: "replace" })).status).toBe(400);
    expect((await b.get("/api/export")).json.tables).toEqual(before);
  });

  it("never touches another account, even when the file carries its ids", async () => {
    const w = world();
    const a = await person(w);
    await build(a, "Alpha");
    const doc = (await a.get("/api/export")).json;
    const aBefore = (await a.get("/api/export")).json.tables;
    const b = await person(w);
    await build(b, "Beta");
    const c = await person(w);
    await build(c, "Gamma");
    const cBefore = (await c.get("/api/export")).json.tables;
    expect((await b.post("/api/restore", { document: doc, confirm: "replace" })).status).toBe(200);
    expect((await a.get("/api/export")).json.tables).toEqual(aBefore);
    expect((await c.get("/api/export")).json.tables).toEqual(cBefore);
  });

  it("needs a signed-in person", async () => {
    const w = world();
    const response = await createApp({
      store: w.store, identity: accountIdentity({ store: w.store, now: w.now, origin: ORIGIN, owner: "o", operatorEmail: "", sessionSecret: "s", google: null, fetch }),
      now: w.now, origin: ORIGIN, timeZone: "UTC", live: { publish: async () => {}, connect: async () => new Response("") },
    })(new Request(`${ORIGIN}/api/restore`, { method: "POST", headers: { origin: ORIGIN, "content-type": "application/json" }, body: "{}" }), () => {});
    expect(response.status).toBe(401);
  });
});

describe("account deletion", () => {
  it("schedules seven days out, shows in /auth/me, keeps sign-in working, and cancels", async () => {
    const w = world();
    const p = await person(w);
    expect((await p.get("/api/deletion")).json).toEqual({ deleteOn: null });
    const set = await p.post("/api/deletion");
    expect(set.status).toBe(200);
    const on = new Date(w.now().getTime() + 7 * DAY).toISOString();
    expect(set.json.deleteOn).toBe(on);
    expect((await p.get("/api/deletion")).json.deleteOn).toBe(on);
    const me = await p.get("/auth/me");
    expect(me.json).toMatchObject({ signedIn: true, deleteOn: on });
    // Asking again keeps the first date.
    w.advance(DAY);
    expect((await p.post("/api/deletion")).json.deleteOn).toBe(on);
    // Sign-in still works.
    const again = await w.person();
    expect(again.id).not.toBe(p.id);
    const cancelled = await p.post("/api/deletion/cancel");
    expect(cancelled.json).toEqual({ deleteOn: null });
    expect((await p.get("/auth/me")).json.deleteOn).toBeNull();
  });

  it("is refused for the copy's owner", async () => {
    const w = world();
    const owner = await w.person(w.copyOwner);
    const refused = await owner.post("/api/deletion");
    expect(refused.status).toBe(403);
    expect((await owner.get("/api/deletion")).json).toEqual({ deleteOn: null });
  });

  it("removes a due account with every row, and only that account", async () => {
    const w = world();
    const gone = await person(w);
    const stays = await person(w);
    await build(gone, "Alpha");
    await build(stays, "Beta");
    const staysBefore = (await stays.get("/api/export")).json.tables;
    await gone.post("/api/deletion");
    await stays.post("/api/deletion");
    await stays.post("/api/deletion/cancel");

    // Not yet.
    w.advance(6 * DAY);
    await accountPurgeJob.run(w.now(), { DB: t.db, OWNER: w.copyOwner } as never);
    expect(await w.store.account(gone.id)).not.toBeNull();

    w.advance(2 * DAY);
    await accountPurgeJob.run(w.now(), { DB: t.db, OWNER: w.copyOwner } as never);
    expect(await w.store.account(gone.id)).toBeNull();
    expect(await w.store.account(stays.id)).not.toBeNull();

    // No row of any table still has the removed owner.
    const tables = (await t.db.prepare(`SELECT name, sql FROM sqlite_master WHERE type = 'table' AND sql LIKE '%owner%'`).all<{ name: string }>()).results;
    for (const { name } of tables) {
      const left = await t.db.prepare(`SELECT count(*) AS n FROM "${name}" WHERE owner = ?`).bind(gone.id).first<{ n: number }>().catch(() => null);
      if (left !== null) expect(left.n, name).toBe(0);
    }
    expect((await t.db.prepare(`SELECT count(*) AS n FROM tenant WHERE id = ?`).bind(gone.id).first<{ n: number }>())?.n).toBe(0);
    expect((await stays.get("/api/export")).json.tables).toEqual(staysBefore);
  });

  it("never removes the copy's owner, even with a date set", async () => {
    const w = world();
    const owner = await w.person(w.copyOwner);
    await t.db.prepare(`UPDATE account SET delete_on = ? WHERE id = ?`).bind(new Date(w.now().getTime() - DAY).toISOString(), owner.id).run();
    await accountPurgeJob.run(w.now(), { DB: t.db, OWNER: w.copyOwner } as never);
    expect(await w.store.account(owner.id)).not.toBeNull();
  });
});
