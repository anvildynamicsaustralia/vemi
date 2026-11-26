import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { KINDS } from "@vemi/shared";
import { createApp, type App } from "./app.js";
import { accountIdentity } from "./accountIdentity.js";
import { hashPassword } from "./password.js";
import { createSetup } from "./setup.js";
import { openStore, type Store } from "./store.js";
import { testDb, type TestDb } from "./testing/d1.js";

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * The authorization matrix. Every route the Worker answers is listed here, with who may reach it.
 * Three things are proved, from a real sign-in against a real D1:
 *
 * 1. Nobody signed out, and nobody holding a forged or another site's request, reaches anything
 *    behind the session: every route not on the allow-list answers 401 (or 403 for a write from
 *    another origin) to an anonymous caller, on every method.
 * 2. A second signed-in account, aimed at the first account's ids on every route that takes one,
 *    reads none of it and changes none of it, and cannot plant a row that points into it.
 * 3. A new route fails here. The route sources are scanned for every path word they match on, and
 *    a word that is in no list below fails the build until it is put in the right one.
 */

const ORIGIN = "https://vemi.example.workers.dev";
const PASSWORD = "a long enough password";
const NOW = new Date("2026-11-20T02:00:00Z");

let t: TestDb;
let store: Store;
let app: App;
let passwordHash: string;

beforeAll(async () => {
  t = await testDb();
  passwordHash = await hashPassword(PASSWORD);
  store = openStore({ DB: t.db }, () => NOW);
  const identity = accountIdentity({
    store, now: () => NOW, origin: ORIGIN, owner: "the-operator", operatorEmail: "",
    sessionSecret: "session-secret", google: null,
    fetch: async () => { throw new Error("a test reached the network"); },
  });
  app = createApp({
    store, now: () => NOW, origin: ORIGIN, timeZone: "UTC", identity, copyOwner: "the-operator",
    setup: createSetup({ store, secret: "a-setup-code", from: "https://setup.example", origin: ORIGIN, move: { owner: "the-operator", identity, publish: async () => {} } }),
    live: { publish: async () => {}, connect: async () => new Response("connected") },
  });
});
afterAll(() => t.dispose());

type Call = (method: string, path: string, body?: unknown, extra?: Record<string, string>) => Promise<Response>;

function caller(cookie: string, sameOrigin = true): Call {
  return (method, path, body, extra = {}) => app(
    new Request(`${ORIGIN}${path}`, {
      method,
      headers: {
        ...(sameOrigin ? { origin: ORIGIN } : { origin: "https://evil.example" }),
        ...(cookie ? { cookie } : {}),
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...extra,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    () => {},
  );
}

interface Account { readonly id: string; readonly cookie: string; readonly call: Call }

async function account(): Promise<Account> {
  const id = `acct-${crypto.randomUUID()}`;
  expect(await store.createAccount({ id, email: `${id}@example.test`, passwordHash, googleSub: null, confirmed: true })).toBe(true);
  const signedIn = await caller("")("POST", "/auth/sign-in", { email: `${id}@example.test`, password: PASSWORD });
  expect(signedIn.status).toBe(200);
  const cookie = (signedIn.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  return { id, cookie, call: caller(cookie) };
}

const json = async <T = Record<string, unknown>>(r: Response): Promise<T> => (await r.json()) as T;

// ---------------------------------------------------------------------------
// The route table
// ---------------------------------------------------------------------------

const METHODS = ["GET", "POST", "PATCH", "PUT", "DELETE"] as const;

/** Every `/api` path shape behind the session, with `x` standing for an id. */
const API_PATHS: readonly string[] = [
  "connector/grants", "connector/grants/x/revoke", "connector/changes", "connector/changes/x/undo",
  "connector/consent", "connector/client",
  "push/key", "push/subscriptions", "push/test", "push/act", "push/subscribe",
  "filters", "filters/dates", "filters/x",
  "appearance", "first-run", "canvas", "overview", "tree", "today", "search", "archived", "locked", "export", "live",
  "encryption", "encryption/start", "encryption/batch", "encryption/finish",
  "keys", "keys/recovery", "keys/start-again", "keys/x/archive", "key-pairing", "key-pairing/x",
  "move-code", "restore", "front", "update", "update/start", "update/step", "update/back", "update/off",
  "deletion", "deletion/cancel",
  "no-such-route", "no-such-route/x",
  ...KINDS.flatMap((k) => [k, `${k}/x`, `${k}/x/delete`, `${k}/x/archive`, `${k}/x/unarchive`]),
].map((p) => `/api/${p}`);

/** Reachable with no session on purpose, each with its reason. A new unprotected route goes here or fails. */
const PUBLIC_API: Readonly<Record<string, string>> = {
  "GET /api/front": "the front page setting: a signed-out visitor asks it before any sign-in; it holds one boolean",
};

/** `/auth` routes that act with no session, each with its reason. */
const PUBLIC_AUTH: Readonly<Record<string, string>> = {
  "GET /auth/me": "tells the page whether it is signed in; signed out it carries only flags",
  "GET /auth/google/callback": "Google's redirect back; checks its own signed state cookie",
  "GET /auth/move-in": "a move link's page; holds nothing without its one-use code",
  "POST /auth/sign-in": "sign in: throttled, answers one message for every failure",
  "POST /auth/sign-out": "clears the cookie; there is nothing to protect",
  "POST /auth/claim": "the first sign-up of a copy with no owner; refused once an owner exists",
  "POST /auth/recover": "a recovery code instead of a password; throttled, one use",
  "POST /auth/reset": "a password reset by emailed one-use link token",
  "POST /auth/invite/accept": "accepting an invitation by one-use link token",
  "POST /auth/link": "what a reset or invite link is for, by one-use link token",
  "POST /auth/google/start": "begins Google sign-in; stores nothing but a signed cookie",
};

/** `/auth` routes that need a session. */
const SESSION_AUTH: readonly string[] = [
  "GET /auth/invites", "GET /auth/people",
  "POST /auth/sign-out-everywhere", "POST /auth/password",
  "POST /auth/two-step/setup", "POST /auth/two-step/verify", "POST /auth/two-step/off",
  "POST /auth/recovery/new", "POST /auth/invite", "POST /auth/invite/withdraw",
  "POST /auth/people/invite", "POST /auth/people/withdraw", "POST /auth/people/remove", "POST /auth/people/reset",
  "POST /auth/google/unlink",
];

/** The routes that answer on their own terms, with who they are for. */
const OTHER_ROUTES: Readonly<Record<string, string>> = {
  "/mcp": "a bearer token an app was given, never a cookie",
  "/oauth/register": "dynamic client registration: public by the OAuth rules, rate limited",
  "/oauth/authorize": "an app's request; shows nothing until a signed-in person consents",
  "/oauth/token": "an app trades a one-use code and its PKCE verifier",
  "/.well-known/oauth-protected-resource": "public metadata",
  "/.well-known/oauth-protected-resource/mcp": "public metadata",
  "/.well-known/oauth-authorization-server": "public metadata",
  "/setup/claim": "the setup page's one-time hand-over, by the copy's own code",
  "/setup/move": "a move by the copy's code or an account's move code",
};

describe("anonymous callers", () => {
  const cases = API_PATHS.flatMap((path) => METHODS.map((method) => ({ method, path })))
    .filter(({ method, path }) => PUBLIC_API[`${method} ${path}`] === undefined);

  it("get a 401 from every /api route and method that is not on the allow-list", async () => {
    const anon = caller("");
    const bad: string[] = [];
    for (const { method, path } of cases) {
      const body = method === "GET" ? undefined : {};
      const res = await anon(method, path, body);
      if (res.status !== 401) bad.push(`${method} ${path} -> ${res.status}`);
      if (res.headers.get("set-cookie") !== null) bad.push(`${method} ${path} set a cookie`);
    }
    expect(bad).toEqual([]);
  });

  it("get a 401 or 403 from a write sent from another site, with no session", async () => {
    const stranger = caller("", false);
    const bad: string[] = [];
    for (const { method, path } of cases.filter((c) => c.method !== "GET")) {
      const res = await stranger(method, path, {});
      if (res.status !== 401 && res.status !== 403) bad.push(`${method} ${path} -> ${res.status}`);
    }
    expect(bad).toEqual([]);
  });

  it("are refused with a forged, truncated or foreign-key session cookie", async () => {
    const real = (await account()).cookie;
    const [name = "", value = ""] = real.split("=");
    const flipped = `${name}=${value.slice(0, -2)}${value.endsWith("AA") ? "BB" : "AA"}`;
    const forgeries = [`${name}=forged`, `${name}=`, flipped, `${name}=${value.split(".")[0] ?? ""}`, "__Host-vemi-out=1; " + real];
    for (const cookie of forgeries) {
      const res = await caller(cookie)("GET", "/api/overview");
      expect(res.status, cookie).toBe(401);
    }
  });

  it("see only the allow-listed public routes without a session", async () => {
    const res = await caller("")("GET", "/api/front");
    expect(res.status).toBe(200);
    expect(Object.keys(await json(res))).toEqual(["landing"]);
  });

  it("are refused on every /auth route that needs a session", async () => {
    const anon = caller("");
    for (const entry of SESSION_AUTH) {
      const [method = "", path = ""] = entry.split(" ");
      const res = await anon(method, path, method === "GET" ? undefined : {});
      expect(res.status, entry).toBeGreaterThanOrEqual(400);
      expect([401, 403], entry).toContain(res.status);
      expect(res.headers.get("set-cookie"), entry).toBeNull();
    }
  });

  it("get a 401 and a challenge from /mcp without a token, and none for a made-up one", async () => {
    for (const authorization of [undefined, "Bearer nonsense", "Basic abc"]) {
      const res = await app(new Request(`${ORIGIN}/mcp`, { method: "POST", headers: { "content-type": "application/json", ...(authorization ? { authorization } : {}) }, body: "{}" }), () => {});
      expect(res.status).toBe(401);
      expect(res.headers.get("www-authenticate")).toContain("resource_metadata");
    }
  });

  it("cannot make a session by posting to the consent route or the setup door", async () => {
    expect((await caller("")("POST", "/api/connector/consent", { decision: "allow" })).status).toBe(401);
    const claim = await caller("", false)("POST", "/setup/claim", { code: "wrong-code", keepUpdated: false });
    expect(claim.status).toBe(403);
  });
});

describe("a signed-in browser used by another site", () => {
  const writes = API_PATHS.flatMap((path) => (["POST", "PATCH", "PUT", "DELETE"] as const).map((method) => ({ method, path })));
  const authWrites = [...Object.keys(PUBLIC_AUTH), ...SESSION_AUTH].filter((e) => e.startsWith("POST ")).map((e) => e.split(" ")[1] ?? "");

  it("is refused on every write, with no Origin and with another site's", async () => {
    const mine = await account();
    const bad: string[] = [];
    for (const origin of [undefined, "https://evil.example", "https://vemi.example.workers.dev.evil.example", "null"]) {
      const headers: Record<string, string> = { cookie: mine.cookie, "content-type": "application/json", ...(origin === undefined ? {} : { origin }) };
      for (const { method, path } of writes) {
        const res = await app(new Request(`${ORIGIN}${path}`, { method, headers, body: "{}" }), () => {});
        if (res.status !== 403) bad.push(`${method} ${path} origin=${origin ?? "none"} -> ${res.status}`);
      }
      for (const path of authWrites) {
        const res = await app(new Request(`${ORIGIN}${path}`, { method: "POST", headers, body: "{}" }), () => {});
        if (res.status !== 403) bad.push(`POST ${path} origin=${origin ?? "none"} -> ${res.status}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it("cannot open the live socket from another site", async () => {
    const mine = await account();
    const res = await app(new Request(`${ORIGIN}/api/live`, { headers: { cookie: mine.cookie, upgrade: "websocket", origin: "https://evil.example" } }), () => {});
    expect(res.status).toBe(403);
  });
});

describe("the route table is complete", () => {
  const read = (file: string): string => readFileSync(join(HERE, file), "utf8");

  it("knows every path word app.ts matches on", () => {
    const source = read("./app.ts");
    const words = new Set<string>();
    for (const m of source.matchAll(/\b(?:first|second|third) === "([a-z-]+)"/g)) words.add(m[1] ?? "");
    for (const m of source.matchAll(/\bcase "([a-z-]+)":/g)) words.add(m[1] ?? "");
    for (const m of source.matchAll(/segments\[\d\] === "([a-z-]+)"/g)) words.add(m[1] ?? "");
    for (const m of source.matchAll(/segments\[3\] === "([a-z-]+)"/g)) words.add(m[1] ?? "");
    for (const m of source.matchAll(/url\.pathname === "\/api\/([a-z-]+)"/g)) words.add(m[1] ?? "");
    const known = new Set(API_PATHS.flatMap((p) => p.replace("/api/", "").split("/")));
    const unknown = [...words].filter((w) => w !== "" && !known.has(w) && w !== "x");
    // A word here is a route this test has never been told about: add it to API_PATHS (or PUBLIC_API with a reason).
    expect(unknown).toEqual([]);
  });

  it("knows every /auth route", () => {
    const source = read("./accountIdentity.ts");
    const found = new Set([...source.matchAll(/case "(\/auth\/[a-z/-]+)":/g)].map((m) => m[1] ?? ""));
    const listed = new Set([...Object.keys(PUBLIC_AUTH), ...SESSION_AUTH].map((e) => e.split(" ")[1] ?? ""));
    expect([...found].filter((p) => !listed.has(p))).toEqual([]);
    expect([...listed].filter((p) => !found.has(p))).toEqual([]);
  });

  it("knows every route the connector and setup answer", () => {
    const found = new Set<string>();
    for (const file of ["./connectorOauth.ts", "./setup.ts"]) {
      for (const m of read(file).matchAll(/(?:case |= )"(\/(?:oauth|\.well-known|mcp|setup)[A-Za-z/.-]*)"/g)) found.add(m[1] ?? "");
    }
    expect([...found].filter((p) => OTHER_ROUTES[p] === undefined)).toEqual([]);
  });

  it("gives every allow-list entry a reason", () => {
    for (const reasons of [PUBLIC_API, PUBLIC_AUTH, OTHER_ROUTES]) {
      for (const [route, why] of Object.entries(reasons)) expect(why.length, route).toBeGreaterThan(10);
    }
  });

  it("lets no other source file answer a path of its own", () => {
    // Only these files may read a request's pathname; a new one is a new door and needs a look.
    const files = ["app.ts", "accountIdentity.ts", "connectorOauth.ts", "setup.ts", "index.ts", "live.ts", "selfUpdate.ts"];
    const bad: string[] = [];
    for (const f of listSources()) {
      if (files.includes(f)) continue;
      if (/new URL\(request\.url\)\.pathname|url\.pathname/.test(read(`./${f}`))) bad.push(f);
    }
    expect(bad).toEqual([]);
  });
});

function listSources(): string[] {
  return readdirSync(HERE).filter((f: string) => f.endsWith(".ts") && !f.endsWith(".test.ts"));
}

// ---------------------------------------------------------------------------
// A second account, aimed at the first
// ---------------------------------------------------------------------------

describe("a second account", () => {
  interface Seeded { readonly ids: Record<string, string>; readonly marker: string }

  async function seed(a: Account): Promise<Seeded> {
    const marker = `zq${crypto.randomUUID().replace(/-/g, "")}`;
    const post = async (path: string, body: unknown): Promise<string> => {
      const res = await a.call("POST", path, body);
      expect(res.status, `${path} ${await res.clone().text()}`).toBeLessThan(300);
      return (await json<{ id: string }>(res)).id;
    };
    const ids: Record<string, string> = {};
    ids.ventures = await post("/api/ventures", { name: `${marker} venture` });
    ids.states = await post("/api/states", { ventureId: ids.ventures, name: `${marker} state`, kind: "underway" });
    ids.stages = await post("/api/stages", { ventureId: ids.ventures, name: `${marker} stage`, kind: "early" });
    ids.projects = await post("/api/projects", { ventureId: ids.ventures, name: `${marker} project` });
    ids.milestones = await post("/api/milestones", { projectId: ids.projects, name: `${marker} milestone` });
    ids.tags = await post("/api/tags", { name: `${marker} tag` });
    ids.tasks = await post("/api/tasks", { ventureId: ids.ventures, projectId: ids.projects, title: `${marker} task`, tagIds: [ids.tags] });
    ids.blockers = await post("/api/blockers", { taskId: ids.tasks, reason: `${marker} reason` });
    ids.notes = await post("/api/notes", { ventureId: ids.ventures, body: `${marker} note` });
    ids.decisions = await post("/api/decisions", { ventureId: ids.ventures, title: `${marker} decision` });
    ids.risks = await post("/api/risks", { ventureId: ids.ventures, title: `${marker} risk` });
    ids.links = await post("/api/links", { taskId: ids.tasks, url: `https://example.test/${marker}` });
    ids.filters = await post("/api/filters", { name: `${marker} filter`, query: marker });
    return { ids, marker };
  }

  /** Everything the account holds, as its own export shows it. */
  const exported = async (a: Account): Promise<string> => (await a.call("GET", "/api/export")).text();

  it("reads none of the first account's data on any read route", async () => {
    const a = await account();
    const b = await account();
    const { ids, marker } = await seed(a);
    const reads = ["overview", "tree", "today", `search?q=${marker}`, "archived", "locked", "export", "filters", "appearance",
      "first-run", "canvas", "keys", "encryption", "push/subscriptions", "connector/grants", "connector/changes", ...KINDS];
    for (const path of reads) {
      const res = await b.call("GET", `/api/${path}`);
      const text = await res.text();
      expect(text.includes(marker), `GET /api/${path}`).toBe(false);
      for (const id of Object.values(ids)) expect(text.includes(id), `GET /api/${path} leaked ${id}`).toBe(false);
    }
    for (const kind of KINDS) {
      for (const suffix of ["", "/delete"]) {
        const res = await b.call("GET", `/api/${kind}/${ids[kind]}${suffix}`);
        expect(res.status, `GET /api/${kind}/<a's id>${suffix}`).toBe(404);
      }
    }
    // And the first account still sees all of it.
    const mine = await exported(a);
    expect(mine.includes(marker)).toBe(true);
  });

  it("changes none of the first account's data with any write route", async () => {
    const a = await account();
    const b = await account();
    const { ids } = await seed(a);
    const before = await exported(a);
    const results: string[] = [];
    const note = async (label: string, res: Response): Promise<void> => {
      if (res.status < 400) results.push(`${label} -> ${res.status} ${await res.text()}`);
    };
    for (const kind of KINDS) {
      const id = ids[kind];
      await note(`PATCH ${kind}`, await b.call("PATCH", `/api/${kind}/${id}`, kind === "tasks" ? { title: "hijack" } : kind === "links" ? { label: "hijack" } : kind === "blockers" ? { reason: "hijack" } : kind === "decisions" || kind === "risks" ? { title: "hijack" } : kind === "notes" ? { body: "hijack" } : { name: "hijack" }));
      await note(`archive ${kind}`, await b.call("POST", `/api/${kind}/${id}/archive`, {}));
      await note(`unarchive ${kind}`, await b.call("POST", `/api/${kind}/${id}/unarchive`, {}));
      await note(`DELETE ${kind}`, await b.call("DELETE", `/api/${kind}/${id}`, { confirm: "hijack" }));
    }
    await note("PATCH filter", await b.call("PATCH", `/api/filters/${ids.filters}`, { name: "hijack" }));
    await note("DELETE filter", await b.call("DELETE", `/api/filters/${ids.filters}`));
    await note("revoke grant", await b.call("POST", "/api/connector/grants/anything/revoke", {}));
    await note("undo change", await b.call("POST", "/api/connector/changes/anything/undo", {}));
    await note("archive key", await b.call("POST", `/api/keys/${ids.ventures}/archive`, {}));
    await note("read pairing", await b.call("GET", `/api/key-pairing/${crypto.randomUUID()}`));
    await note("act on reminder", await b.call("POST", "/api/push/act", { taskId: ids.tasks, action: "done", at: "2026-11-20T09:00" }));
    expect(results).toEqual([]);
    expect(await exported(a)).toBe(before);
  });

  it("cannot plant a row that points into the first account's records", async () => {
    const a = await account();
    const b = await account();
    const { ids } = await seed(a);
    const mine = await json<{ id: string }>(await b.call("POST", "/api/ventures", { name: "Mine" }));
    const bProject = await json<{ id: string }>(await b.call("POST", "/api/projects", { ventureId: mine.id, name: "Mine" }));
    const bTask = await json<{ id: string }>(await b.call("POST", "/api/tasks", { ventureId: mine.id, title: "Mine" }));
    const before = await exported(a);
    const planted: Array<[string, string, unknown]> = [
      ["POST", "/api/projects", { ventureId: ids.ventures, name: "x" }],
      ["POST", "/api/ventures", { name: "x", parentId: ids.ventures }],
      ["POST", "/api/states", { ventureId: ids.ventures, name: "x", kind: "underway" }],
      ["POST", "/api/stages", { ventureId: ids.ventures, name: "x", kind: "early" }],
      ["POST", "/api/milestones", { projectId: ids.projects, name: "x" }],
      ["POST", "/api/tasks", { ventureId: ids.ventures, title: "x" }],
      ["POST", "/api/tasks", { ventureId: mine.id, projectId: ids.projects, title: "x" }],
      ["POST", "/api/tasks", { ventureId: mine.id, milestoneId: ids.milestones, title: "x" }],
      ["POST", "/api/tasks", { ventureId: mine.id, stateId: ids.states, title: "x" }],
      ["POST", "/api/tasks", { ventureId: mine.id, tagIds: [ids.tags], title: "x" }],
      ["POST", "/api/blockers", { taskId: ids.tasks, reason: "x" }],
      ["POST", "/api/blockers", { taskId: bTask.id, waitsOnTaskId: ids.tasks, reason: "x" }],
      ["POST", "/api/notes", { ventureId: ids.ventures, body: "x" }],
      ["POST", "/api/notes", { projectId: ids.projects, body: "x" }],
      ["POST", "/api/decisions", { projectId: ids.projects, title: "x" }],
      ["POST", "/api/risks", { ventureId: ids.ventures, title: "x" }],
      ["POST", "/api/links", { taskId: ids.tasks, url: "https://example.test/x" }],
      ["POST", "/api/links", { ventureId: ids.ventures, url: "https://example.test/x" }],
      ["PATCH", `/api/ventures/${mine.id}`, { stageId: ids.stages }],
      ["PATCH", `/api/ventures/${mine.id}`, { parentId: ids.ventures }],
      ["PATCH", `/api/projects/${bProject.id}`, { ventureId: ids.ventures }],
      ["PATCH", `/api/projects/${bProject.id}`, { stageId: ids.stages }],
      ["PATCH", `/api/projects/${bProject.id}`, { tagIds: [ids.tags] }],
      ["PATCH", `/api/projects/${bProject.id}`, { parentId: ids.projects }],
      ["PATCH", `/api/tasks/${bTask.id}`, { ventureId: ids.ventures }],
      ["PATCH", `/api/tasks/${bTask.id}`, { projectId: ids.projects }],
      ["PATCH", `/api/tasks/${bTask.id}`, { milestoneId: ids.milestones }],
      ["PATCH", `/api/tasks/${bTask.id}`, { stateId: ids.states }],
      ["PATCH", `/api/tasks/${bTask.id}`, { tagIds: [ids.tags] }],
    ];
    const accepted: string[] = [];
    for (const [method, path, body] of planted) {
      const res = await b.call(method, path, body);
      if (res.status < 400) accepted.push(`${method} ${path} ${JSON.stringify(body)} -> ${res.status}`);
    }
    expect(accepted).toEqual([]);
    expect(await exported(a)).toBe(before);
    // Nothing of the first account's ids rode into the second account's own data either.
    const own = await exported(b);
    for (const id of Object.values(ids)) expect(own.includes(id), id).toBe(false);
  });

  it("cannot read a restore or a move code made by the first account", async () => {
    const a = await account();
    const b = await account();
    const code = await json<{ code: string }>(await a.call("POST", "/api/move-code", {}));
    // A move code names the account that made it: asked for by anyone, it still lands there only,
    // and a person who holds none is told nothing about it.
    const res = await caller("", false)("POST", "/setup/move", { code: code.code }, { origin: "https://setup.example" });
    expect([400, 403]).toContain(res.status);
    const seen = await b.call("GET", "/api/overview");
    expect(await seen.text()).not.toContain(code.code);
  });
});
