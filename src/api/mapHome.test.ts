import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_APPEARANCE } from "@vemi/shared";
import { createApp, type App } from "./app.js";
import { accountIdentity } from "./accountIdentity.js";
import { hashPassword } from "./password.js";
import { openStore, type Outcome, type Store } from "./store.js";
import { migrationStatements, testDb, type TestDb } from "./testing/d1.js";
import { parseAppearance, parseCanvas, parsePatch } from "./validate.js";
import { PROFILE_DEFAULTS } from "./testing/profileDefaults.js";

/**
 * 0016_map_home: the account's map style, a project's pin and the canvas positions. One
 * database holds 0001 to 0015 with old venture positions, the file is applied, and every
 * assertion maps to a line of the phase's Done: the copy, the second run, the pin, the style,
 * the canvas routes and the isolation between two accounts.
 */

type Row = Record<string, unknown>;
const T = "2026-01-01T00:00:00.000Z";
const ORIGIN = "https://vemi.example.workers.dev";
const PASSWORD = "a long enough password";

function must<V>(outcome: Outcome<V>): V {
  if (!outcome.ok) throw new Error(`${outcome.status}: ${outcome.error}`);
  return outcome.value;
}

describe("0016_map_home over a database holding 0001 to 0015", () => {
  let old: TestDb;
  const go = (sql: string, ...binds: unknown[]) => old.db.prepare(sql).bind(...binds).run();
  const all = async (sql: string): Promise<Row[]> => (await old.db.prepare(sql).all<Row>()).results;
  const apply = async (again: boolean) => {
    for (const sql of migrationStatements((f) => f.startsWith("0016_"))) {
      try {
        await old.db.prepare(sql).run();
      } catch (e) {
        // SQLite has no ADD COLUMN IF NOT EXISTS. The migration runner never applies a file
        // twice; the only statements allowed to refuse on a second pass are the two columns.
        if (!(again && e instanceof Error && e.message.includes("duplicate column name"))) throw e;
      }
    }
  };
  const canvasRows = () => all(`SELECT owner, kind, id, x, y FROM canvas_pos ORDER BY owner, kind, id`);

  beforeAll(async () => {
    old = await testDb({ through: "0015_appearance.sql" });
    for (const o of ["owner-a", "owner-b"]) await go(`INSERT INTO tenant (id, created_at) VALUES (?, ?)`, o, T);
    const v = (id: string, o: string, x: number | null, y: number | null, z: number | null) =>
      go(`INSERT INTO venture (id, owner, name, map_x, map_y, map_z, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        id, o, id, x, y, z, T, T);
    await v("a-placed", "owner-a", 10, 20, null);
    await v("a-zoomed", "owner-a", 30, 40, 5);
    await v("a-half", "owner-a", 50, null, null);
    await v("a-none", "owner-a", null, null, null);
    await v("b-placed", "owner-b", 70, 80, null);
    await apply(false);
  });
  afterAll(() => old.dispose());

  it("copies exactly the venture positions with x and y and no z, each to its own owner", async () => {
    expect(await canvasRows()).toEqual([
      { owner: "owner-a", kind: "venture", id: "a-placed", x: 10, y: 20 },
      { owner: "owner-b", kind: "venture", id: "b-placed", x: 70, y: 80 },
    ]);
  });

  it("leaves the old venture columns in place", async () => {
    const row = (await all(`SELECT map_x, map_y, map_z FROM venture WHERE id = 'a-zoomed'`))[0];
    expect(row).toEqual({ map_x: 30, map_y: 40, map_z: 5 });
  });

  it("adds pinned_at, empty, to every project", async () => {
    await go(`INSERT INTO project (id, owner, venture_id, name, created_at, updated_at) VALUES ('p1', 'owner-a', 'a-placed', 'P', ?, ?)`, T, T);
    expect((await all(`SELECT pinned_at FROM project`))[0]).toEqual({ pinned_at: null });
  });

  it("defaults every account to the grid and refuses a style outside grid and canvas", async () => {
    await go(`INSERT INTO account (id, email, password_hash, created_at, updated_at) VALUES ('owner-a', 'a@example.test', 'x', ?, ?)`, T, T);
    expect((await all(`SELECT map_style FROM account`))[0]).toEqual({ map_style: "grid" });
    await expect(go(`UPDATE account SET map_style = 'list'`)).rejects.toThrow();
    await go(`UPDATE account SET map_style = 'canvas'`);
  });

  it("refuses a canvas position that names neither a venture nor a project, or has no owner", async () => {
    await expect(go(`INSERT INTO canvas_pos (owner, kind, id, x, y) VALUES ('owner-a', 'task', 't', 1, 1)`)).rejects.toThrow();
    await expect(go(`INSERT INTO canvas_pos (owner, kind, id, x, y) VALUES ('', 'venture', 'v', 1, 1)`)).rejects.toThrow();
  });

  it("changes nothing when the file is applied a second time", async () => {
    // A person moved a box since the copy: the second run must not put it back.
    await go(`UPDATE canvas_pos SET x = 99 WHERE id = 'a-placed'`);
    const before = { canvas: await canvasRows(), venture: await all(`SELECT * FROM venture ORDER BY id`), account: await all(`SELECT * FROM account`) };
    await apply(true);
    expect(await canvasRows()).toEqual(before.canvas);
    expect(await all(`SELECT * FROM venture ORDER BY id`)).toEqual(before.venture);
    expect(await all(`SELECT * FROM account`)).toEqual(before.account);
  });
});

describe("the map home through the store and the routes", () => {
  let t: TestDb;
  let store: Store;
  let app: App;
  let passwordHash: string;
  const NOW = new Date("2026-11-16T02:00:00Z");

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

  async function account(): Promise<{ owner: string; venture: string; project: string }> {
    const owner = `owner-${crypto.randomUUID()}`;
    expect(await store.createAccount({ id: owner, email: `${owner}@example.test`, passwordHash, googleSub: null, confirmed: true })).toBe(true);
    const venture = must(await store.create(owner, "ventures", { id: crypto.randomUUID(), name: "Space" })).record.id;
    const project = must(await store.create(owner, "projects", { id: crypto.randomUUID(), ventureId: venture, name: "Project" })).record.id;
    return { owner, venture, project };
  }

  it("keeps the account's map style, defaulting to grid, and saves it with the other three", async () => {
    const a = await account();
    const empty = { ...DEFAULT_APPEARANCE, newTaskVentureId: null, lastReviewOn: null, morningAt: null, taskReminders: false, quietFrom: null, quietTo: null, ...PROFILE_DEFAULTS };
    expect(await store.appearance(a.owner)).toEqual(empty);
    expect(DEFAULT_APPEARANCE.mapStyle).toBe("grid");
    const saved = must(await store.setAppearance(a.owner, { mapStyle: "canvas" }));
    expect(saved).toEqual({ ...empty, mapStyle: "canvas" });
    expect(await store.appearance(a.owner)).toEqual(saved);
    const next = must(await store.setAppearance(a.owner, { theme: "dark" }));
    expect(next).toEqual({ ...empty, mapStyle: "canvas", theme: "dark" });
  });

  it("takes mapStyle on an appearance patch and refuses any other value", () => {
    expect(parseAppearance({ mapStyle: "canvas" })).toEqual({ ok: true, value: { mapStyle: "canvas" } });
    expect(parseAppearance({ mapStyle: "list" })).toEqual({ ok: false, error: "mapStyle must be grid or canvas" });
  });

  it("pins a project by a patch, returns pinnedAt, and clears it with null", async () => {
    const a = await account();
    expect((await store.get(a.owner, "projects", a.project))?.pinnedAt).toBeNull();
    const patch = parsePatch("projects", { pinnedAt: "2026-11-16T01:00:00.000Z" });
    if (!patch.ok) throw new Error(patch.error);
    const pinned = must(await store.update(a.owner, "projects", a.project, patch.value)).record;
    expect(pinned.pinnedAt).toBe("2026-11-16T01:00:00.000Z");
    const tree = await store.tree(a.owner);
    expect(tree.ventures[0]!.projects[0]!.pinnedAt).toBe("2026-11-16T01:00:00.000Z");
    const cleared = parsePatch("projects", { pinnedAt: null });
    if (!cleared.ok) throw new Error(cleared.error);
    expect(must(await store.update(a.owner, "projects", a.project, cleared.value)).record.pinnedAt).toBeNull();
  });

  it("refuses a pinnedAt that is not a time", () => {
    for (const bad of ["yesterday", 5, true, "2026-11-16"]) expect(parsePatch("projects", { pinnedAt: bad }).ok, String(bad)).toBe(false);
  });

  it("stores canvas positions per account and upserts a second batch over the first", async () => {
    const a = await account();
    expect(await store.canvas(a.owner)).toEqual([]);
    must(await store.setCanvas(a.owner, [
      { kind: "venture", id: a.venture, x: 1, y: 2 }, { kind: "project", id: a.project, x: 3, y: 4 },
    ]));
    const moved = must(await store.setCanvas(a.owner, [{ kind: "venture", id: a.venture, x: 100.5, y: -2 }]));
    expect(moved).toEqual([
      { kind: "project", id: a.project, x: 3, y: 4 },
      { kind: "venture", id: a.venture, x: 100.5, y: -2 },
    ]);
    expect(await store.canvas(a.owner)).toEqual(moved);
  });

  it("keeps two accounts apart: B sees none of A's boxes and cannot place or move one of A's", async () => {
    const a = await account();
    const b = await account();
    must(await store.setCanvas(a.owner, [{ kind: "venture", id: a.venture, x: 5, y: 6 }]));
    expect(await store.canvas(b.owner)).toEqual([]);
    const refused = await store.setCanvas(b.owner, [{ kind: "venture", id: a.venture, x: 999, y: 999 }]);
    expect(refused).toEqual({ ok: false, status: 404, error: "a venture in the list is not in this account" });
    expect(await store.canvas(a.owner)).toEqual([{ kind: "venture", id: a.venture, x: 5, y: 6 }]);
    expect(await store.canvas(b.owner)).toEqual([]);
    // B's own map style is B's alone.
    await store.setAppearance(b.owner, { mapStyle: "canvas" });
    expect((await store.appearance(a.owner)).mapStyle).toBe("grid");
  });

  it("refuses the whole batch when one box is not the account's, placing none", async () => {
    const a = await account();
    const refused = await store.setCanvas(a.owner, [{ kind: "venture", id: a.venture, x: 1, y: 1 }, { kind: "project", id: "nobody", x: 2, y: 2 }]);
    expect(refused.ok).toBe(false);
    expect(await store.canvas(a.owner)).toEqual([]);
  });

  it("checks a canvas body before it reaches the store", () => {
    const ok = { kind: "venture", id: "v", x: 1, y: 2 };
    expect(parseCanvas({ positions: [ok] })).toEqual({ ok: true, value: [ok] });
    expect(parseCanvas({ positions: [] })).toEqual({ ok: true, value: [] });
    for (const bad of [
      {}, { positions: "no" }, { positions: [{ ...ok, kind: "task" }] }, { positions: [{ ...ok, x: "1" }] },
      { positions: [{ ...ok, y: Number.POSITIVE_INFINITY }] }, { positions: [{ ...ok, id: "" }] },
      { positions: [{ ...ok, z: 1 }] }, { positions: [ok, ok] }, { positions: [ok], extra: 1 },
    ]) expect(parseCanvas(bad).ok, JSON.stringify(bad)).toBe(false);
  });

  it("answers GET and PUT /api/canvas for the caller only, and refuses other methods", async () => {
    const a = await account();
    const b = await account();
    const signIn = async (owner: string): Promise<string> => {
      const res = await app(new Request(`${ORIGIN}/auth/sign-in`, {
        method: "POST", headers: { origin: ORIGIN, "content-type": "application/json" },
        body: JSON.stringify({ email: `${owner}@example.test`, password: PASSWORD }),
      }), () => {});
      expect(res.status).toBe(200);
      return (res.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    };
    const call = (cookie: string, method: string, body?: unknown) => app(new Request(`${ORIGIN}/api/canvas`, {
      method, headers: { origin: ORIGIN, cookie, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    }), () => {});
    const ca = await signIn(a.owner);
    const cb = await signIn(b.owner);

    expect(await (await call(ca, "GET")).json()).toEqual({ positions: [] });
    const put = await call(ca, "PUT", { positions: [{ kind: "project", id: a.project, x: 7, y: 8 }] });
    expect(put.status).toBe(200);
    expect(await put.json()).toEqual({ positions: [{ kind: "project", id: a.project, x: 7, y: 8 }] });
    expect(await (await call(ca, "GET")).json()).toEqual({ positions: [{ kind: "project", id: a.project, x: 7, y: 8 }] });
    expect(await (await call(cb, "GET")).json()).toEqual({ positions: [] });
    expect((await call(cb, "PUT", { positions: [{ kind: "project", id: a.project, x: 1, y: 1 }] })).status).toBe(404);
    expect((await call(ca, "PUT", { positions: [{ kind: "task", id: "x", x: 1, y: 1 }] })).status).toBe(400);
    expect((await call(ca, "PATCH", { positions: [] })).status).toBe(405);
    expect((await call("", "GET")).status).toBe(401);
  });
});
