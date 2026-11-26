import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp, type App } from "./app.js";
import { accountIdentity } from "./accountIdentity.js";
import { hashPassword } from "./password.js";
import { openStore, type Store } from "./store.js";
import { testDb, type TestDb } from "./testing/d1.js";

/** 0021_saved_filter and /api/filters, through the real routes and a real D1. */

const ORIGIN = "https://vemi.example.workers.dev";
const PASSWORD = "a long enough password";
const NOW = new Date("2026-11-18T02:00:00Z");

let t: TestDb;
let store: Store;
let app: App;
let passwordHash: string;

beforeAll(async () => {
  t = await testDb();
  passwordHash = await hashPassword(PASSWORD);
  store = openStore({ DB: t.db }, () => NOW);
  app = createApp({
    store, now: () => NOW, origin: ORIGIN, timeZone: "Australia/Sydney",
    identity: accountIdentity({
      store, now: () => NOW, origin: ORIGIN, owner: "the-operator", operatorEmail: "",
      sessionSecret: "session-secret", google: null,
      fetch: async () => { throw new Error("a test reached the network"); },
    }),
    live: { publish: async () => {}, connect: async () => new Response("connected") },
  });
});
afterAll(() => t.dispose());

interface Person {
  readonly owner: string;
  readonly call: (method: string, path: string, body?: unknown) => Promise<Response>;
}

async function person(): Promise<Person> {
  const owner = `owner-${crypto.randomUUID()}`;
  const email = `${owner}@example.test`;
  expect(await store.createAccount({ id: owner, email, passwordHash, googleSub: null, confirmed: true })).toBe(true);
  let cookie = "";
  const call: Person["call"] = (method, path, body) => app(
    new Request(`${ORIGIN}${path}`, {
      method,
      headers: { origin: ORIGIN, ...(cookie ? { cookie } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    () => {},
  );
  const signedIn = await call("POST", "/auth/sign-in", { email, password: PASSWORD });
  expect(signedIn.status).toBe(200);
  cookie = (signedIn.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  return { owner, call };
}

type Filter = { id: string; name: string; query: string; position: number };
const list = async (p: Person) => ((await (await p.call("GET", "/api/filters")).json()) as { filters: Filter[] }).filters;

describe("0021_saved_filter", () => {
  it("makes an owned table with archived_at", async () => {
    const cols = (await t.db.prepare(`PRAGMA table_info(saved_filter)`).all<{ name: string }>()).results.map((r) => r.name);
    expect(cols).toEqual(["id", "owner", "name", "query", "position", "created_at", "archived_at"]);
  });
});

describe("/api/filters", () => {
  it("starts empty, then lists what was saved in order", async () => {
    const p = await person();
    expect(await list(p)).toEqual([]);
    const a = await p.call("POST", "/api/filters", { name: "  Due soon ", query: "due:today" });
    expect(a.status).toBe(201);
    const first = (await a.json()) as Filter;
    expect(first).toMatchObject({ name: "Due soon", query: "due:today", position: 1 });
    expect(typeof first.id).toBe("string");
    await p.call("POST", "/api/filters", { name: "Second", query: "x" });
    expect((await list(p)).map((f) => f.name)).toEqual(["Due soon", "Second"]);
  });

  it("holds name to 1 to 60 characters and query to 1 to 200", async () => {
    const p = await person();
    const post = async (body: unknown) => (await p.call("POST", "/api/filters", body)).status;
    expect(await post({ name: "", query: "x" })).toBe(400);
    expect(await post({ name: "   ", query: "x" })).toBe(400);
    expect(await post({ name: "n".repeat(61), query: "x" })).toBe(400);
    expect(await post({ name: "n".repeat(60), query: "x" })).toBe(201);
    expect(await post({ name: "ok", query: "" })).toBe(400);
    expect(await post({ name: "ok", query: "q".repeat(201) })).toBe(400);
    expect(await post({ name: "ok", query: "q".repeat(200) })).toBe(201);
    expect(await post({ name: 5, query: "x" })).toBe(400);
    expect(await post({ name: "ok" })).toBe(400);
    expect(await post([])).toBe(400);
  });

  it("refuses an unknown key on create and rename", async () => {
    const p = await person();
    const bad = await p.call("POST", "/api/filters", { name: "a", query: "b", colour: "red" });
    expect(bad.status).toBe(400);
    const made = (await (await p.call("POST", "/api/filters", { name: "a", query: "b" })).json()) as Filter;
    expect((await p.call("PATCH", `/api/filters/${made.id}`, { name: "c", query: "z" })).status).toBe(400);
    expect((await p.call("PATCH", `/api/filters/${made.id}`, {})).status).toBe(400);
    expect((await list(p))[0]).toMatchObject({ name: "a", query: "b" });
  });

  it("renames, and a rename keeps the query", async () => {
    const p = await person();
    const made = (await (await p.call("POST", "/api/filters", { name: "a", query: "b" })).json()) as Filter;
    const res = await p.call("PATCH", `/api/filters/${made.id}`, { name: " Renamed " });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id: made.id, name: "Renamed", query: "b" });
    expect((await p.call("PATCH", `/api/filters/${made.id}`, { name: "" })).status).toBe(400);
    expect((await p.call("PATCH", "/api/filters/nope", { name: "x" })).status).toBe(404);
  });

  it("allows 30 and refuses the 31st, and a removed one frees a place", async () => {
    const p = await person();
    for (let i = 0; i < 30; i++) expect((await p.call("POST", "/api/filters", { name: `f${i}`, query: "q" })).status).toBe(201);
    const over = await p.call("POST", "/api/filters", { name: "one more", query: "q" });
    expect(over.status).toBe(409);
    const all = await list(p);
    expect(all).toHaveLength(30);
    expect((await p.call("DELETE", `/api/filters/${all[0]?.id}`)).status).toBe(200);
    expect((await p.call("POST", "/api/filters", { name: "one more", query: "q" })).status).toBe(201);
    expect(await list(p)).toHaveLength(30);
  });

  it("never shows or changes another account's filter", async () => {
    const a = await person();
    const b = await person();
    const mine = (await (await a.call("POST", "/api/filters", { name: "mine", query: "q" })).json()) as Filter;
    expect(await list(b)).toEqual([]);
    expect((await b.call("PATCH", `/api/filters/${mine.id}`, { name: "taken" })).status).toBe(404);
    expect((await b.call("DELETE", `/api/filters/${mine.id}`)).status).toBe(404);
    expect(await list(a)).toEqual([expect.objectContaining({ id: mine.id, name: "mine" })]);
  });

  it("removes only the saved search, never a task or a project", async () => {
    const p = await person();
    const space = (await store.create(p.owner, "ventures", { id: crypto.randomUUID(), name: "Space" }));
    if (!space.ok) throw new Error(space.error);
    const made = (await (await p.call("POST", "/api/filters", { name: "Keep", query: "Keep me" })).json()) as Filter;
    const count = async (table: string) =>
      (await t.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE owner = ? AND archived_at IS NULL`).bind(p.owner).first<{ n: number }>())?.n;
    expect(await count("venture")).toBe(1);
    expect((await p.call("DELETE", `/api/filters/${made.id}`)).status).toBe(200);
    expect(await list(p)).toEqual([]);
    expect((await p.call("DELETE", `/api/filters/${made.id}`)).status).toBe(404);
    expect(await count("venture")).toBe(1);
  });

  it("answers the wrong method with 405 and needs a session", async () => {
    const p = await person();
    expect((await p.call("PUT", "/api/filters", { name: "a", query: "b" })).status).toBe(405);
    expect((await p.call("POST", "/api/filters/abc", { name: "a" })).status).toBe(405);
    const out = await app(new Request(`${ORIGIN}/api/filters`, { headers: { origin: ORIGIN } }), () => {});
    expect(out.status).toBe(401);
  });
});
