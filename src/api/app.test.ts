import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { KINDS, type Change } from "@vemi/shared";
import { createApp, localDate, type App, type AppDeps } from "./app.js";
import { accountIdentity } from "./accountIdentity.js";
import { hashPassword } from "./password.js";
import { openStore } from "./store.js";
import { testDb, type TestDb } from "./testing/d1.js";
import { PROFILE_DEFAULTS } from "./testing/profileDefaults.js";

/**
 * The routes, through the real identity and a real D1. The session comes from a real
 * sign-in against a stored account, so every `/api` call here is authenticated the way a
 * browser's is.
 */

const ORIGIN = "https://vemi.example.workers.dev";
const PASSWORD = "a long enough password";

let t: TestDb;
let passwordHash: string;
beforeAll(async () => {
  t = await testDb();
  passwordHash = await hashPassword(PASSWORD);
});
afterAll(() => t.dispose());

interface Harness {
  readonly call: (method: string, path: string, body?: unknown, headers?: Record<string, string>) => Promise<Response>;
  readonly published: Change[];
  readonly connected: Request[];
  readonly owner: string;
  readonly store: ReturnType<typeof openStore>;
  /** The session cookie as the browser holds it, `name=value`. */
  readonly session: () => string;
  setNow(at: string): void;
  /** Wait for the work a response left running behind it, as `ctx.waitUntil` would. */
  settle(): Promise<void>;
}

async function harness(extra: Partial<AppDeps> = {}): Promise<Harness> {
  const owner = `owner-${crypto.randomUUID()}`;
  let now = new Date("2026-09-14T02:00:00Z");
  const clock = () => now;
  const store = openStore({ DB: t.db }, clock);
  const published: Change[] = [];
  const connected: Request[] = [];
  const behind: Promise<unknown>[] = [];
  const app: App = createApp({
    ...extra,
    store,
    now: clock,
    origin: ORIGIN,
    timeZone: "Australia/Sydney",
    identity: accountIdentity({
      store,
      now: clock,
      origin: ORIGIN,
      owner: "the-operator",
      operatorEmail: "",
      sessionSecret: "session-secret",
      
      google: null,
      fetch: async () => {
        throw new Error("a test reached the network");
      },
    }),
    live: {
      publish: async (_owner, change) => {
        published.push(change);
      },
      connect: async (_owner, request) => {
        connected.push(request);
        return new Response("connected");
      },
    },
  });

  let cookie = "";
  const call: Harness["call"] = (method, path, body, headers = {}) => app(
    new Request(`${ORIGIN}${path}`, {
      method,
      headers: {
        origin: ORIGIN,
        ...(cookie ? { cookie } : {}),
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    (work) => {
      behind.push(work);
    },
  );

  const email = `${owner}@example.test`;
  expect(await store.createAccount({ id: owner, email, passwordHash, googleSub: null, confirmed: true })).toBe(true);
  const signedIn = await call("POST", "/auth/sign-in", { email, password: PASSWORD });
  expect(signedIn.status).toBe(200);
  cookie = (signedIn.headers.get("set-cookie") ?? "").split(";")[0] ?? "";

  return {
    call,
    published,
    connected,
    owner,
    store,
    session: () => cookie,
    setNow: (at) => { now = new Date(at); },
    settle: async () => {
      while (behind.length > 0) await Promise.all(behind.splice(0));
    },
  };
}

const body = async <T = Record<string, unknown>>(response: Response): Promise<T> => response.json() as Promise<T>;

describe("the API", () => {
  it("refuses every /api route without a session", async () => {
    const h = await harness();
    for (const path of ["/api/overview", "/api/tree", "/api/today", "/api/tasks", "/api/search?q=Studios"]) {
      const response = await h.call("GET", path, undefined, { cookie: "" });
      expect(response.status, path).toBe(401);
    }
    const forged = await h.call("GET", "/api/overview", undefined, { cookie: "__Host-vemi=YW5keQo5OTk5OTk5OTk5.bm9wZQ" });
    expect(forged.status).toBe(401);
    expect(await body(forged)).toEqual({ error: "Sign in first." });
  });

  it("refuses a signed session whose account is gone", async () => {
    const h = await harness();
    await t.db.prepare(`DELETE FROM account WHERE id = ?`).bind(h.owner).run();
    const response = await h.call("GET", "/api/overview");
    expect(response.status).toBe(401);
    expect(await body(response)).toEqual({ error: "This account no longer exists." });
  });

  it("refuses an older session once sign out everywhere has moved the generation on", async () => {
    const h = await harness();
    const v = await body<{ id: string }>(await h.call("POST", "/api/ventures", { name: "Studios" }));
    const before = h.session();
    expect((await h.call("POST", "/auth/sign-out-everywhere", {})).status).toBe(200);
    const refused = await h.call("GET", "/api/overview", undefined, { cookie: before });
    expect(refused.status).toBe(401);
    expect(await body(refused)).toEqual({ error: "Signed out everywhere. Sign in again." });
    // Every read is refused whole, whatever it found, and so is a write and the live channel.
    for (const path of ["/api/tree", "/api/today", "/api/overview", "/api/tasks", `/api/ventures/${v.id}`, "/api/search?q=Studios"]) {
      const read = await h.call("GET", path, undefined, { cookie: before });
      expect(read.status, path).toBe(401);
      expect(await read.text(), path).not.toContain("Studios");
    }
    const write = await h.call("PATCH", `/api/ventures/${v.id}`, { name: "Renamed" }, { cookie: before });
    expect(write.status).toBe(401);
    const socket = await h.call("GET", "/api/live", undefined, { cookie: before, upgrade: "websocket" });
    expect(socket.status).toBe(401);
    expect(h.connected).toHaveLength(0);
  });

  it("answers GET /api/overview with all four figures for every venture in one round trip, the session check in it", async () => {
    const h = await harness();
    const v = await body<{ id: string }>(await h.call("POST", "/api/ventures", { name: "Studios", description: "Ship it" }));
    const old = await h.call("POST", "/api/ventures", { name: "Old client", goal: "Ship it" });
    expect(old.status).toBe(400);
    await h.call("POST", "/api/tasks", { ventureId: v.id, title: "A task" });

    t.resetCount();
    const response = await h.call("GET", "/api/overview");
    // The session's row rides in the route's own batch.
    expect(t.queries()).toBe(1);
    const overview = await body<{ ventures: { own: Record<string, unknown>; total: Record<string, unknown> }[] }>(response);
    expect(Object.keys(overview.ventures[0]?.own ?? {}).sort()).toEqual(["blocked", "nextMilestone", "tasksLeft", "underway"]);
    expect(overview.ventures[0]?.total).toMatchObject({ tasksLeft: 1 });
  });

  it("creates a task from a title and a venture alone and tells the live channel", async () => {
    const h = await harness();
    const v = await body<{ id: string }>(await h.call("POST", "/api/ventures", { name: "Farm" }));
    const response = await h.call("POST", "/api/tasks", { ventureId: v.id, title: "Check the bore pump" });
    expect(response.status).toBe(201);
    const created = await body<{ id: string }>(response);
    expect(created).not.toHaveProperty("icon");
    expect(h.published.at(-1)).toEqual({ kind: "tasks", id: created.id, ventureId: v.id });
  });

  it("no longer takes where a venture or a project sat on Space", async () => {
    // Space is cut. board_x and board_y stay in their columns, but nothing reads or writes them.
    const h = await harness();
    const v = await body<{ id: string }>(await h.call("POST", "/api/ventures", { name: "Farm" }));
    expect(v).not.toHaveProperty("boardX");
    expect((await h.call("PATCH", `/api/ventures/${v.id}`, { boardX: 240.5, boardY: -80 })).status).toBe(400);
    expect((await h.call("POST", "/api/projects", { ventureId: v.id, name: "Fencing", boardX: 12 })).status).toBe(400);
  });

  it("nests a project through the route: parentId lands, clears, and a non-id or a third level is refused", async () => {
    const h = await harness();
    const v = await body<{ id: string }>(await h.call("POST", "/api/ventures", { name: "Nest" }));
    const top = await body<{ id: string }>(await h.call("POST", "/api/projects", { ventureId: v.id, name: "Top" }));
    const inner = await body<{ id: string; parentId: string | null }>(
      await h.call("POST", "/api/projects", { ventureId: v.id, name: "Inner", parentId: top.id }));
    expect(inner.parentId).toBe(top.id);

    const cleared = await body<{ parentId: string | null }>(await h.call("PATCH", `/api/projects/${inner.id}`, { parentId: null }));
    expect(cleared.parentId).toBeNull();
    const again = await body<{ parentId: string | null }>(await h.call("PATCH", `/api/projects/${inner.id}`, { parentId: top.id }));
    expect(again.parentId).toBe(top.id);

    expect((await h.call("POST", "/api/projects", { ventureId: v.id, name: "Bad", parentId: 7 })).status).toBe(400);
    expect((await h.call("PATCH", `/api/projects/${inner.id}`, { parentId: 7 })).status).toBe(400);

    const third = await h.call("POST", "/api/projects", { ventureId: v.id, name: "Third", parentId: inner.id });
    expect(third.status).toBe(409);
  });

  it("carries no map position on a venture, and refuses one sent", async () => {
    const h = await harness();
    const v = await body<Record<string, unknown> & { id: string }>(await h.call("POST", "/api/ventures", { name: "Farm" }));
    expect(v).not.toHaveProperty("mapX");
    expect((await h.call("POST", "/api/ventures", { name: "Studio", mapX: 1 })).status).toBe(400);
    expect((await h.call("PATCH", `/api/ventures/${v.id}`, { mapX: 1.25 })).status).toBe(400);
    const overview = await body<{ ventures: readonly Record<string, unknown>[] }>(await h.call("GET", "/api/overview"));
    expect(overview.ventures.find((x) => x.id === v.id)).not.toHaveProperty("mapX");
  });

  it("orders today by a number of its own, not by the board column's", async () => {
    // Decision 23: the picked list crosses columns, so `position` cannot order it.
    const h = await harness();
    const v = await body<{ id: string }>(await h.call("POST", "/api/ventures", { name: "Farm" }));
    const t = await body<{ id: string; position: number; todayPosition: number | null }>(
      await h.call("POST", "/api/tasks", { ventureId: v.id, title: "Check the bore pump", position: 5 }));
    expect(t.todayPosition).toBeNull();

    const picked = await body<{ position: number; todayPosition: number | null }>(
      await h.call("PATCH", `/api/tasks/${t.id}`, { todayPosition: 2.5 }));
    expect(picked.todayPosition).toBe(2.5);
    expect(picked.position).toBe(5);
  });

  it("no longer takes a parked time on a task", async () => {
    const h = await harness();
    const v = await body<{ id: string }>(await h.call("POST", "/api/ventures", { name: "Farm" }));
    const t = await body<{ id: string; parkedAt?: unknown }>(
      await h.call("POST", "/api/tasks", { ventureId: v.id, title: "Rebuild the shed" }));
    expect(t.parkedAt).toBeUndefined();
    expect((await h.call("PATCH", `/api/tasks/${t.id}`, { parkedAt: "2026-09-17T02:00:00.000Z" })).status).toBe(400);
    expect((await h.call("PATCH", `/api/tasks/${t.id}`, { parkedAt: null })).status).toBe(400);
    expect((await h.call("POST", "/api/tasks", { ventureId: v.id, title: "Mend the gate", parkedAt: null })).status).toBe(400);
  });

  it("takes at risk as a true or false and nothing else, and a stage only by a patch", async () => {
    const h = await harness();
    const v = await body<{ id: string; atRisk: boolean; stageId: string | null }>(
      await h.call("POST", "/api/ventures", { name: "Farm" }));
    const p = await body<{ id: string }>(await h.call("POST", "/api/projects", { ventureId: v.id, name: "Fencing" }));
    expect([v.atRisk, v.stageId]).toEqual([false, null]);

    for (const path of [`/api/ventures/${v.id}`, `/api/projects/${p.id}`]) {
      for (const bad of [1, "yes", null]) expect((await h.call("PATCH", path, { atRisk: bad })).status, `${path} ${String(bad)}`).toBe(400);
      expect((await body<{ atRisk: boolean }>(await h.call("PATCH", path, { atRisk: true }))).atRisk).toBe(true);
    }

    expect((await h.call("POST", "/api/ventures", { name: "Mill", stageId: "x" })).status).toBe(400);
    expect((await h.call("POST", "/api/ventures", { name: "Mill", atRisk: true })).status).toBe(400);
    expect((await h.call("POST", "/api/projects", { ventureId: v.id, name: "Gate", stageId: "x" })).status).toBe(400);
    expect((await h.call("POST", "/api/projects", { ventureId: v.id, name: "Gate", atRisk: true })).status).toBe(400);
  });

  it("keeps a stage's kinds and a state's kinds apart, and the two doors apart", async () => {
    const h = await harness();
    const v = await body<{ id: string }>(await h.call("POST", "/api/ventures", { name: "Farm" }));
    expect((await h.call("POST", "/api/states", { ventureId: v.id, name: "soon", kind: "early" })).status).toBe(400);
    expect((await h.call("POST", "/api/stages", { ventureId: v.id, name: "soon", kind: "underway" })).status).toBe(400);
    const stage = await body<{ id: string }>(await h.call("POST", "/api/stages", { ventureId: v.id, name: "Prototype", kind: "early" }));
    expect((await h.call("PATCH", `/api/stages/${stage.id}`, { kind: "underway" })).status).toBe(400);
    expect((await h.call("PATCH", `/api/states/${stage.id}`, { name: "Renamed" })).status).toBe(404);
  });

  it("refuses what it cannot store honestly", async () => {
    const h = await harness();
    const v = await body<{ id: string }>(await h.call("POST", "/api/ventures", { name: "Farm" }));
    const t1 = await body<{ id: string }>(await h.call("POST", "/api/tasks", { ventureId: v.id, title: "x" }));
    expect((await h.call("POST", "/api/tasks", { ventureId: v.id })).status).toBe(400);
    expect((await h.call("POST", "/api/tasks", { ventureId: v.id, title: "x", dueDate: "2026-09-14" })).status).toBe(400);
    expect((await h.call("POST", "/api/tasks", { ventureId: v.id, title: "x", dueOn: "2026-02-30" })).status).toBe(400);
    expect((await h.call("POST", "/api/links", { taskId: t1.id, url: "javascript:alert(1)" })).status).toBe(400);
    expect((await h.call("POST", "/api/tasks", "not an object")).status).toBe(400);
    const plain = await h.call("POST", "/api/tasks", undefined, { "content-type": "text/plain" });
    expect(plain.status).toBe(415);
    // A type that only mentions JSON is not JSON, and a page elsewhere may send it unasked.
    const sneaky = await h.call("POST", "/api/tasks", { ventureId: v.id, title: "x" }, { "content-type": "text/plain; x=application/json" });
    expect(sneaky.status).toBe(415);
    expect((await h.call("POST", "/api/tasks", { ventureId: v.id, title: "y" }, { "content-type": "Application/JSON; charset=utf-8" })).status).toBe(201);
  });

  it("refuses every write from another origin, and changes nothing", async () => {
    const h = await harness();
    const v = await body<{ id: string; name: string }>(await h.call("POST", "/api/ventures", { name: "Kept" }));
    await h.settle();
    const archived = await body<{ id: string }>(await h.call("POST", "/api/ventures", { name: "Archived" }));
    expect((await h.call("POST", `/api/ventures/${archived.id}/archive`)).status).toBe(200);
    await h.settle();
    const before = await body(await h.call("GET", "/api/tree"));

    for (const origin of ["https://evil.example", "https://sibling.example.workers.dev", "null"]) {
      const foreign = { origin };
      const writes = [
        h.call("POST", `/api/ventures/${v.id}/archive`, undefined, foreign),
        h.call("POST", `/api/ventures/${archived.id}/unarchive`, undefined, foreign),
        h.call("PATCH", `/api/ventures/${v.id}`, { name: "Renamed" }, foreign),
        h.call("POST", "/api/ventures", { name: "Planted" }, foreign),
        h.call("DELETE", `/api/ventures/${archived.id}`, { confirm: "Archived" }, foreign),
      ];
      for (const response of await Promise.all(writes)) {
        expect(response.status, origin).toBe(403);
        expect(await body(response)).toEqual({ error: "cross-origin request refused" });
      }
    }
    // No Origin at all is refused too: every browser sends one on a write.
    expect((await h.call("PATCH", `/api/ventures/${v.id}`, { name: "Renamed" }, { origin: "" })).status).toBe(403);
    await h.settle();
    expect(await body(await h.call("GET", "/api/tree"))).toEqual(before);

    // A read from anywhere is still answered, and the page's own writes still land.
    expect((await h.call("GET", "/api/tree", undefined, { origin: "https://evil.example" })).status).toBe(200);
    expect((await h.call("PATCH", `/api/ventures/${v.id}`, { name: "Renamed" })).status).toBe(200);
  });

  it("asks sameOrigin for a write and a socket, and the Worker's own rule by default", async () => {
    // Left out: the Worker's rule, a cross-origin write is refused and a same-origin one lands.
    const worker = await harness();
    const foreign = await worker.call("POST", "/api/ventures", { name: "Planted" }, { origin: "https://evil.example" });
    expect(foreign.status).toBe(403);
    expect(await body(foreign)).toEqual({ error: "cross-origin request refused" });
    expect((await worker.call("POST", "/api/ventures", { name: "Kept" })).status).toBe(201);
    expect((await worker.call("GET", "/api/live", undefined, { upgrade: "websocket", origin: "https://evil.example" })).status).toBe(403);

    // Given: its answer decides, whatever Origin says.
    const seen: string[] = [];
    const page = await harness({ sameOrigin: (request) => { seen.push(request.method); return request.headers.get("x-page") === "yes"; } });
    expect((await page.call("POST", "/api/ventures", { name: "A" }, { origin: ORIGIN })).status).toBe(403);
    expect((await page.call("POST", "/api/ventures", { name: "B" }, { origin: "https://evil.example", "x-page": "yes" })).status).toBe(201);
    expect((await page.call("GET", "/api/live", undefined, { upgrade: "websocket" })).status).toBe(403);
    expect((await page.call("GET", "/api/live", undefined, { upgrade: "websocket", "x-page": "yes" })).status).toBe(200);
    // A read is not asked.
    seen.length = 0;
    expect((await page.call("GET", "/api/tree")).status).toBe(200);
    expect(seen).toEqual([]);
  });

  it("makes a create sent twice under the client's id once, and tells the live channel once", async () => {
    const h = await harness();
    const v = await body<{ id: string }>(await h.call("POST", "/api/ventures", { name: "Farm" }));
    const id = crypto.randomUUID();
    const sent = { id, ventureId: v.id, title: "Queued while offline" };

    const first = await h.call("POST", "/api/tasks", sent);
    expect(first.status).toBe(201);
    const created = await body<{ id: string }>(first);
    expect(created.id).toBe(id);
    const heard = h.published.length;

    const again = await h.call("POST", "/api/tasks", sent);
    expect(again.status).toBe(201);
    expect(await body(again)).toEqual(created);
    expect(h.published).toHaveLength(heard);
    expect((await body<{ id: string }[]>(await h.call("GET", `/api/tasks?venture=${v.id}`))).map((r) => r.id)).toEqual([id]);

    expect((await h.call("POST", "/api/projects", { id, ventureId: v.id, name: "Same id, other kind" })).status).toBe(409);
    const other = await harness();
    expect((await other.call("POST", "/api/ventures", { id, name: "Someone else's" })).status).toBe(409);
    for (const bad of ["short", "has a space in it", "x".repeat(65), 12345678, null]) {
      expect((await h.call("POST", "/api/tasks", { id: bad, ventureId: v.id, title: "x" })).status, String(bad)).toBe(400);
    }
    expect((await h.call("PATCH", `/api/tasks/${id}`, { id: "another-id-entirely" })).status).toBe(400);
  });

  it("stores a link typed without a scheme as https, so it does not open the app itself", async () => {
    const h = await harness();
    const v = await body<{ id: string }>(await h.call("POST", "/api/ventures", { name: "Studios" }));
    const x = await body<{ id: string }>(await h.call("POST", "/api/tasks", { ventureId: v.id, title: "Read" }));
    const stored = async (url: string) =>
      (await body<{ url: string }>(await h.call("POST", "/api/links", { taskId: x.id, url }))).url;

    expect(await stored("example.com")).toBe("https://example.com");
    expect(await stored("  www.example.com/a?b=c  ")).toBe("https://www.example.com/a?b=c");
    expect(await stored("//example.com/path")).toBe("https://example.com/path");
    expect(await stored("localhost:5173/board")).toBe("https://localhost:5173/board");
    expect(await stored("example.com:8080")).toBe("https://example.com:8080");
    expect(await stored("http://example.com")).toBe("http://example.com");
    expect(await stored("mailto:tommy@example.com")).toBe("mailto:tommy@example.com");
    expect(await stored("obsidian://open?vault=notes")).toBe("obsidian://open?vault=notes");
    for (const bad of ["javascript:alert(1)", "JavaScript:alert(1)", "data:text/html,hi", "vbscript:x"]) {
      expect((await h.call("POST", "/api/links", { taskId: x.id, url: bad })).status, bad).toBe(400);
    }
    const link = await body<{ id: string }>(await h.call("POST", "/api/links", { taskId: x.id, url: "https://a.example" }));
    expect((await body<{ url: string }>(await h.call("PATCH", `/api/links/${link.id}`, { url: "b.example" }))).url).toBe("https://b.example");
  });

  it("refuses a link patch that moves it to another parent, and a task size or icon", async () => {
    const h = await harness();
    const v = await body<{ id: string }>(await h.call("POST", "/api/ventures", { name: "Studios" }));
    const p = await body<{ id: string }>(await h.call("POST", "/api/projects", { ventureId: v.id, name: "Site" }));
    const x = await body<{ id: string }>(await h.call("POST", "/api/tasks", { ventureId: v.id, title: "Read" }));
    const link = await body<{ id: string; role: string }>(await h.call("POST", "/api/links", { ventureId: v.id, url: "https://a.example" }));
    expect(link.role).toBe("other");

    for (const moved of [{ ventureId: v.id }, { projectId: p.id }, { taskId: x.id }]) {
      expect((await h.call("PATCH", `/api/links/${link.id}`, moved)).status, JSON.stringify(moved)).toBe(400);
    }
    expect((await h.call("PATCH", `/api/links/${link.id}`, { role: "repo" })).status).toBe(200);
    expect((await h.call("POST", "/api/links", { ventureId: v.id, projectId: p.id, url: "https://a.example" })).status).toBe(400);
    expect((await h.call("POST", "/api/links", { ventureId: v.id, url: "https://a.example", role: "boss" })).status).toBe(400);

    const described = await body<{ id: string; description: string | null }>(
      await h.call("POST", "/api/projects", { ventureId: v.id, name: "Docs", description: "About it" }),
    );
    expect(described.description).toBe("About it");
    expect((await body<{ description: string | null }>(await h.call("PATCH", `/api/projects/${described.id}`, { description: "" }))).description).toBeNull();
    expect((await body<{ description: string | null }>(await h.call("PATCH", `/api/ventures/${v.id}`, { description: "" }))).description).toBeNull();

    expect((await h.call("POST", "/api/tasks", { ventureId: v.id, title: "Sized", size: "s" })).status).toBe(400);
    expect((await h.call("POST", "/api/tasks", { ventureId: v.id, title: "Marked", icon: "lucide:rocket" })).status).toBe(400);
    expect((await h.call("PATCH", `/api/tasks/${x.id}`, { size: null })).status).toBe(400);
    expect((await h.call("PATCH", `/api/tasks/${x.id}`, { icon: null })).status).toBe(400);
  });

  it("opens the whole tag door without a route of its own, and carries tags on a task", async () => {
    const h = await harness();
    const v = await body<{ id: string }>(await h.call("POST", "/api/ventures", { name: "Studios" }));

    const made = await h.call("POST", "/api/tags", { name: "legal" });
    expect(made.status).toBe(201);
    const legal = await body<{ id: string; name: string }>(made);
    expect(legal.name).toBe("legal");
    const admin = await body<{ id: string }>(await h.call("POST", "/api/tags", { name: "admin" }));

    expect((await body<{ name: string }>(await h.call("PATCH", `/api/tags/${legal.id}`, { name: "compliance" }))).name)
      .toBe("compliance");
    expect((await body<{ id: string }[]>(await h.call("GET", "/api/tags"))).map((r) => r.id)).toEqual([admin.id, legal.id]);
    expect((await h.call("GET", `/api/tags/${legal.id}`)).status).toBe(200);

    // Strict on purpose: a field a tag does not have is refused, never quietly dropped.
    expect((await h.call("POST", "/api/tags", { name: "deep work", colour: "red" })).status).toBe(400);
    expect((await h.call("POST", "/api/tags", { name: "   " })).status).toBe(400);
    expect((await h.call("POST", "/api/tags", { name: "admin" })).status).toBe(409);

    const x = await body<{ id: string }>(
      await h.call("POST", "/api/tasks", { ventureId: v.id, title: "File the return", tagIds: [legal.id, admin.id] }),
    );
    const tree = await body<{ ventures: { tasks: { id: string; tagIds: string[] }[] }[] }>(await h.call("GET", "/api/tree"));
    expect(tree.ventures[0]?.tasks[0]).toMatchObject({ id: x.id, tagIds: [admin.id, legal.id] });
    expect((await h.call("PATCH", `/api/tasks/${x.id}`, { tagIds: [] })).status).toBe(200);
    expect((await h.call("PATCH", `/api/tasks/${x.id}`, { tagIds: ["nothing-by-that-id"] })).status).toBe(404);
    const notAnId = await h.call("PATCH", `/api/tasks/${x.id}`, { tagIds: [1] });
    expect(notAnId.status).toBe(400);
    // One item of the list, said in the singular: never "each tagIds must be an id".
    expect((await body<{ error: string }>(notAnId)).error).toBe("each item in tagIds must be an id");
    // Venture links are cut: no route serves them.
    expect((await h.call("POST", "/api/venture-links", { ventureIds: ["a-venture", "b-venture"] })).status).toBe(405);
    expect((await h.call("GET", "/api/venture-links")).status).toBe(404);

    // The archive pair and the delete door, both generic over the kind.
    expect((await h.call("POST", `/api/tags/${admin.id}/archive`)).status).toBe(200);
    expect((await body<{ confirm: string }>(await h.call("GET", `/api/tags/${admin.id}/delete`))).confirm).toBe("admin");
    expect((await h.call("DELETE", `/api/tags/${admin.id}`, { confirm: "admin" })).status).toBe(200);
    expect((await h.call("GET", `/api/tags/${admin.id}`)).status).toBe(404);
  });

  it("refuses a DELETE that is not one record, named", async () => {
    const h = await harness();
    const v = await body<{ id: string }>(await h.call("POST", "/api/ventures", { name: "Studios" }));
    for (const kind of KINDS) {
      // A whole collection, and a path that is not a record, are both 405 with the shape
      // that works. Decision 33: there is one door and it is on a single record.
      expect((await h.call("DELETE", `/api/${kind}`, { confirm: "Studios" })).status, kind).toBe(405);
      expect((await h.call("DELETE", `/api/${kind}/${v.id}/archive`, { confirm: "Studios" })).status, kind).toBe(405);
    }
    expect((await h.call("DELETE", "/api/nonsense/x", { confirm: "Studios" })).status).toBe(405);
    // Without the name, nothing happens.
    expect((await h.call("DELETE", `/api/ventures/${v.id}`, {})).status).toBe(400);
    expect((await h.call("GET", `/api/ventures/${v.id}`)).status).toBe(200);
  });

  it("answers a DELETE whose body is not an object with 400, not a crash", async () => {
    const h = await harness();
    const v = await body<{ id: string }>(await h.call("POST", "/api/ventures", { name: "Studios" }));
    for (const sent of [null, [], "confirm", 7]) {
      expect((await h.call("DELETE", `/api/ventures/${v.id}`, sent)).status, JSON.stringify(sent)).toBe(400);
    }
  });

  it("refuses a body past the ceiling with 413 before parsing it, and takes a restore far larger", async () => {
    const h = await harness();
    const filler = "x".repeat(9 * 1024 * 1024);
    expect((await h.call("POST", "/api/ventures", { name: "Studios", icon: filler })).status).toBe(413);
    // The auth routes carry a few hundred bytes at most.
    const big = await h.call("POST", "/auth/sign-in", { email: "a@b.c", password: "x".repeat(70_000) }, { cookie: "" });
    expect(big.status).toBe(413);
    // A restore may carry a whole export, so 9 MB is past the plain ceiling and not past its own.
    const restore = await h.call("POST", "/api/restore", { document: { format: "vemi-export", version: 1, tables: {}, filler } });
    expect(restore.status).not.toBe(413);
  });

  it("answers a route that fails unexpectedly in JSON, without the cause", async () => {
    const h = await harness();
    (h.store as { create: unknown }).create = async () => { throw new Error("D1_ERROR: secret detail"); };
    const response = await h.call("POST", "/api/ventures", { name: "Studios" });
    expect(response.status).toBe(500);
    expect(response.headers.get("content-type")).toContain("application/json");
    const said = await body<{ error: string }>(response);
    expect(said.error).not.toContain("secret detail");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("says what a delete would destroy, and refuses one that is not archived", async () => {
    const h = await harness();
    const v = await body<{ id: string }>(await h.call("POST", "/api/ventures", { name: "Studios" }));
    const x = await body<{ id: string }>(await h.call("POST", "/api/tasks", { ventureId: v.id, title: "Chase it" }));

    const live = await body<{ refusal: string; confirm: string; removes: { tasks: number } }>(
      await h.call("GET", `/api/ventures/${v.id}/delete`),
    );
    expect(live.refusal).toBe("Archive it first. Only something already archived can be deleted.");
    expect(live.confirm).toBe("Studios");
    expect(live.removes.tasks).toBe(1);
    expect((await h.call("DELETE", `/api/ventures/${v.id}`, { confirm: "Studios" })).status).toBe(409);
    expect((await h.call("GET", `/api/ventures/${v.id}`)).status).toBe(200);

    expect((await h.call("GET", "/api/ventures/nobody/delete")).status).toBe(404);
    expect((await h.call("POST", `/api/ventures/${v.id}/delete`, {})).status).toBe(405);
    expect((await h.call("GET", `/api/tasks/${x.id}/delete`, undefined, { cookie: "" })).status).toBe(401);
    expect((await h.call("DELETE", `/api/tasks/${x.id}`, { confirm: "Chase it" }, { cookie: "" })).status).toBe(401);
  });

  it("deletes an archived record, tells the open clients, and then it is gone", async () => {
    const h = await harness();
    const v = await body<{ id: string }>(await h.call("POST", "/api/ventures", { name: "Studios" }));
    const x = await body<{ id: string }>(await h.call("POST", "/api/tasks", { ventureId: v.id, title: "Chase it" }));
    expect((await h.call("POST", `/api/tasks/${x.id}/archive`)).status).toBe(200);
    h.published.length = 0;

    expect((await h.call("DELETE", `/api/tasks/${x.id}`, { confirm: "Chased it" })).status).toBe(400);
    const gone = await h.call("DELETE", `/api/tasks/${x.id}`, { confirm: "Chase it" });
    expect(gone.status).toBe(200);
    expect(await body(gone)).toEqual({
      removes: {
        ventures: 0, states: 0, stages: 0, projects: 0, milestones: 0,
        tasks: 1, blockers: 0, notes: 0, decisions: 0, risks: 0, links: 0,
        tags: 0, taskTags: 0, projectTags: 0,
      },
    });
    await h.settle();
    expect(h.published).toEqual([{ kind: "tasks", id: x.id, ventureId: v.id }]);

    expect((await h.call("GET", `/api/tasks/${x.id}`)).status).toBe(404);
    expect((await h.call("DELETE", `/api/tasks/${x.id}`, { confirm: "Chase it" })).status).toBe(404);
    expect((await body<{ items: unknown[] }>(await h.call("GET", "/api/archived"))).items).toEqual([]);
    expect((await h.call("GET", `/api/ventures/${v.id}`)).status).toBe(200);
  });

  it("archives and unarchives through the routes", async () => {
    const h = await harness();
    const v = await body<{ id: string }>(await h.call("POST", "/api/ventures", { name: "Studios" }));
    const x = await body<{ id: string }>(await h.call("POST", "/api/tasks", { ventureId: v.id, title: "Chase" }));

    expect((await h.call("POST", `/api/tasks/${x.id}/archive`)).status).toBe(200);
    expect(await body(await h.call("GET", `/api/tasks?venture=${v.id}`))).toEqual([]);
    const archived = await body<{ items: { id: string }[] }>(await h.call("GET", "/api/archived"));
    expect(archived.items.map((i) => i.id)).toContain(x.id);

    expect((await h.call("POST", `/api/tasks/${x.id}/unarchive`)).status).toBe(200);
    expect((await body<{ id: string }[]>(await h.call("GET", `/api/tasks?venture=${v.id}`))).map((r) => r.id)).toEqual([x.id]);
    expect((await h.call("GET", `/api/tasks?colour=red`)).status).toBe(400);
  });

  it("turns today over at midnight in Sydney, not in UTC", async () => {
    const h = await harness();
    // 15:00 UTC on the 14th is 01:00 on the 15th in Sydney.
    h.setNow("2026-09-14T15:00:00Z");
    expect(localDate(new Date("2026-09-14T15:00:00Z"), "Australia/Sydney")).toBe("2026-09-15");
    const v = await body<{ id: string }>(await h.call("POST", "/api/ventures", { name: "Personal" }));
    const x = await body<{ id: string }>(await h.call("POST", "/api/tasks", { ventureId: v.id, title: "Picked", pickedOn: "2026-09-15" }));

    const today = await body<{ on: string; tasks: { id: string }[] }>(await h.call("GET", "/api/today"));
    expect(today.on).toBe("2026-09-15");
    expect(today.tasks.map((task) => task.id)).toEqual([x.id]);
    expect((await body<{ tasks: unknown[] }>(await h.call("GET", "/api/today?on=2026-09-14"))).tasks).toEqual([]);
    expect((await h.call("GET", "/api/today?on=tomorrow")).status).toBe(400);
  });

  it("turns today over at the viewer's own midnight when the page says its zone", async () => {
    const h = await harness();
    // 15:00 UTC on the 14th: the 15th in Sydney, still the 14th in London and New York.
    h.setNow("2026-09-14T15:00:00Z");
    const v = await body<{ id: string }>(await h.call("POST", "/api/ventures", { name: "Abroad" }));
    const x = await body<{ id: string }>(await h.call("POST", "/api/tasks", { ventureId: v.id, title: "Picked", pickedOn: "2026-09-14" }));

    const london = await body<{ on: string; tasks: { id: string }[] }>(await h.call("GET", "/api/today?tz=Europe%2FLondon"));
    expect(london.on).toBe("2026-09-14");
    expect(london.tasks.map((task) => task.id)).toEqual([x.id]);
    expect((await body<{ on: string }>(await h.call("GET", "/api/today?tz=America%2FNew_York"))).on).toBe("2026-09-14");
    // A zone this runtime does not know is the server's zone, never a failure.
    for (const odd of ["Mars/Olympus", "", "x".repeat(65)]) {
      expect((await body<{ on: string }>(await h.call("GET", `/api/today?tz=${odd}`))).on, odd).toBe("2026-09-15");
    }
    // A date asked for outright still wins.
    expect((await body<{ on: string }>(await h.call("GET", "/api/today?tz=Europe%2FLondon&on=2026-09-20"))).on).toBe("2026-09-20");

    const exported = await h.call("GET", "/api/export?tz=Europe%2FLondon");
    expect(exported.headers.get("content-disposition")).toBe(`attachment; filename="vemi-export-2026-09-14.json"`);
    // The file is named for the day in the viewer's zone, either side of midnight.
    for (const [zone, on] of [["Australia%2FSydney", "2026-09-15"], ["Europe%2FLondon", "2026-09-14"]] as const) {
      const named = await h.call("GET", `/api/export?tz=${zone}`);
      expect(named.headers.get("content-disposition")).toBe(`attachment; filename="vemi-export-${on}.json"`);
    }
  });

  it("hands a same-origin WebSocket upgrade to the live channel and refuses anything else", async () => {
    const h = await harness();
    expect((await h.call("GET", "/api/live")).status).toBe(426);
    expect((await h.call("GET", "/api/live", undefined, { upgrade: "websocket", origin: "https://evil.example" })).status).toBe(403);
    const ok = await h.call("GET", "/api/live", undefined, { upgrade: "websocket" });
    expect(await ok.text()).toBe("connected");
    expect(h.connected).toHaveLength(1);
  });

  it("serves no duties", async () => {
    const h = await harness();
    const v = await body<{ id: string }>(await h.call("POST", "/api/ventures", { name: "Farm" }));
    expect((await h.call("POST", "/api/duties", { ventureId: v.id, name: "The yards" })).status).toBe(405);
    expect((await h.call("GET", `/api/duties?venture=${v.id}`)).status).toBe(404);
  });

  it("searches", async () => {
    const h = await harness();
    await h.call("POST", "/api/ventures", { name: "Black Dingo Network" });
    const found = await body<{ results: { kind: string; text: string }[] }>(await h.call("GET", "/api/search?q=dingo"));
    expect(found.results).toEqual([expect.objectContaining({ kind: "venture", text: "Black Dingo Network" })]);
  });

  it("serves the whole account as a downloadable JSON file", async () => {
    const h = await harness();
    const v = await body<{ id: string }>(await h.call("POST", "/api/ventures", { name: "Exported Co" }));

    const response = await h.call("GET", "/api/export");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
    const filename = `vemi-export-${localDate(new Date("2026-09-14T02:00:00Z"), "Australia/Sydney")}.json`;
    expect(response.headers.get("content-disposition")).toBe(`attachment; filename="${filename}"`);

    const doc = await body<{ format: string; tables: { venture: { id: string; name: string }[] } }>(response);
    expect(doc.format).toBe("vemi-export");
    expect(doc.tables.venture.map((r) => r.id)).toContain(v.id);

    // Markdown is gone: the old format switch is ignored and JSON is served.
    expect((await h.call("GET", "/api/export?format=md")).headers.get("content-type")).toBe("application/json; charset=utf-8");

    expect((await h.call("POST", "/api/export")).status).toBe(405);
    expect((await h.call("GET", "/api/export", undefined, { cookie: "" })).status).toBe(401);
  });

  it("keeps the account's look, Ember comfortable and match device until it is changed", async () => {
    const h = await harness();
    const first = await h.call("GET", "/api/appearance");
    expect(await body(first)).toEqual({ accent: "ember", spacing: "comfortable", theme: "system", mapStyle: "grid", newTaskVentureId: null, lastReviewOn: null, morningAt: null, taskReminders: false, quietFrom: null, quietTo: null, ...PROFILE_DEFAULTS });

    const some = await h.call("PATCH", "/api/appearance", { accent: "moss", theme: "dark" });
    expect(some.status).toBe(200);
    const moss = { accent: "moss", spacing: "comfortable", theme: "dark", mapStyle: "grid", newTaskVentureId: null, lastReviewOn: null, morningAt: null, taskReminders: false, quietFrom: null, quietTo: null, ...PROFILE_DEFAULTS };
    expect(await body(some)).toEqual(moss);
    expect(await body(await h.call("GET", "/api/appearance"))).toEqual(moss);

    expect((await h.call("PATCH", "/api/appearance", { spacing: "compact" })).status).toBe(200);
    expect((await h.call("PATCH", "/api/appearance", { accent: "teal" })).status).toBe(400);
    expect((await h.call("PATCH", "/api/appearance", { spacing: "tight" })).status).toBe(400);
    expect((await h.call("PATCH", "/api/appearance", { theme: "auto" })).status).toBe(400);
    expect((await h.call("PATCH", "/api/appearance", { colour: "red" })).status).toBe(400);
    expect((await h.call("PATCH", "/api/appearance", {})).status).toBe(400);
    expect((await h.call("POST", "/api/appearance", {})).status).toBe(405);
    expect((await h.call("GET", "/api/appearance", undefined, { cookie: "" })).status).toBe(401);

    // Another account is untouched.
    const other = await harness();
    expect(await body(await other.call("GET", "/api/appearance"))).toEqual({ accent: "ember", spacing: "comfortable", theme: "system", mapStyle: "grid", newTaskVentureId: null, lastReviewOn: null, morningAt: null, taskReminders: false, quietFrom: null, quietTo: null, ...PROFILE_DEFAULTS });
  });

  it("hardens every response", async () => {
    const h = await harness();
    const response = await h.call("GET", "/api/overview");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect((await h.call("GET", "/nowhere")).status).toBe(404);
  });
});
