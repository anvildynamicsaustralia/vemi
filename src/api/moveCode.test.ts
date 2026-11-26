import { afterEach, describe, expect, it, vi } from "vitest";
import { accountIdentity } from "./accountIdentity.js";
import { createApp } from "./app.js";
import { moveCodeId } from "./move.js";
import { hashPassword } from "./password.js";
import { sessionKey } from "./sessionKey.js";
import { createSetup } from "./setup.js";
import { openStore } from "./store.js";
import { testDb } from "./testing/d1.js";

/**
 * A code from an existing account: `POST /api/move-code` makes it for whoever is signed in,
 * `POST /setup/move` spends it to put a file's rows in that account.
 */

const ORIGIN = "https://vemi.example.workers.dev";
const FROM = "https://get.example.org";
const PASSWORD = "correct horse battery";

vi.setConfig({ testTimeout: 180_000 });

const disposers: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const d of disposers.splice(0)) await d();
});

async function copy() {
  const db = await testDb();
  disposers.push(() => db.dispose());
  let at = Date.now();
  const now = () => new Date(at);
  const store = openStore({ DB: db.db }, now);
  const identity = accountIdentity({
    store, now, origin: ORIGIN, owner: "owner", operatorEmail: "",
    sessionSecret: () => sessionKey(store), google: null, setupClaim: false,
    fetch: (async () => { throw new Error("no network"); }) as typeof fetch,
  });
  const publish = vi.fn(async () => {});
  const app = createApp({
    store, identity, now, origin: ORIGIN, timeZone: "UTC", copyOwner: "owner",
    setup: createSetup({ store, secret: "a-setup-code", from: FROM, origin: ORIGIN, move: { owner: "owner", identity, publish } }),
    live: { publish, connect: async () => new Response("connected") },
  });
  const call = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Response> =>
    app(new Request(`${ORIGIN}${path}`, {
      method,
      headers: { origin: ORIGIN, "cf-connecting-ip": "10.1.1.1", ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    }), () => {});
  const move = (body: unknown): Promise<Response> =>
    app(new Request(`${ORIGIN}/setup/move`, {
      method: "POST",
      headers: { "content-type": "application/json", "cf-connecting-ip": "10.1.1.1", origin: FROM },
      body: JSON.stringify(body),
    }), () => {});
  const cookieOf = (r: Response): string => (r.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; ");
  const owner = async (): Promise<string> =>
    cookieOf(await call("POST", "/auth/claim", { email: "owner@example.com", password: PASSWORD }));
  const guest = async (): Promise<string> => {
    await store.createAccount({ id: "guest", email: "guest@example.com", passwordHash: await hashPassword(PASSWORD), googleSub: null, confirmed: true });
    return cookieOf(await call("POST", "/auth/sign-in", { email: "guest@example.com", password: PASSWORD }));
  };
  const code = async (cookie: string): Promise<{ code: string; expiresAt: string }> =>
    (await call("POST", "/api/move-code", {}, { cookie })).json() as Promise<{ code: string; expiresAt: string }>;
  const tasks = async (id: string): Promise<number> => (await store.exportAll(id, now())).tables.task?.length ?? 0;
  return { store, call, move, owner, guest, code, tasks, db, advance: (ms: number) => { at += ms; }, publish };
}

let filed: Promise<Record<string, unknown>> | null = null;
const file = () => (filed ??= makeFile());

async function makeFile(): Promise<Record<string, unknown>> {
  const donor = await copy();
  const cookie = await donor.owner();
  const api = async (path: string, body?: unknown): Promise<Record<string, unknown>> =>
    (await donor.call(body === undefined ? "GET" : "POST", path, body, { cookie })).json() as Promise<Record<string, unknown>>;
  const space = await api("/api/ventures", { name: "Studios" });
  await api("/api/tasks", { ventureId: space.id, title: "First" });
  await api("/api/tasks", { ventureId: space.id, title: "Second" });
  const document = await api("/api/export");
  await donor.db.dispose();
  return document;
}

describe("making a code", () => {
  it("needs a signed-in account", async () => {
    const c = await copy();
    expect((await c.call("POST", "/api/move-code", {})).status).toBe(401);
  });

  it("answers a code good for 15 minutes, kept only as a hash", async () => {
    const c = await copy();
    const made = await c.code(await c.owner());
    expect(made.code).toMatch(/\S{12,}/);
    expect(new Date(made.expiresAt).getTime() - Date.now()).toBeGreaterThan(14 * 60_000);
    expect(new Date(made.expiresAt).getTime() - Date.now()).toBeLessThanOrEqual(15 * 60_000 + 5_000);
    expect(await c.store.pendingToken(await moveCodeId(made.code), "confirm")).not.toBeNull();
    expect(await c.store.pendingToken(made.code, "confirm")).toBeNull();
  });

  it("is never in the export", async () => {
    const c = await copy();
    const cookie = await c.owner();
    const made = await c.code(cookie);
    const exported = await (await c.call("GET", "/api/export", undefined, { cookie })).text();
    expect(exported).not.toContain(made.code);
    expect(exported).not.toContain(await moveCodeId(made.code));
  });

  it("is made for an invited account as well", async () => {
    const c = await copy();
    await c.owner();
    const made = await c.code(await c.guest());
    expect((await c.store.pendingToken(await moveCodeId(made.code), "confirm"))?.owner).toBe("guest");
  });

  it("retires the one before it", async () => {
    const c = await copy();
    const cookie = await c.owner();
    const { document } = { document: await file() };
    const first = await c.code(cookie);
    const second = await c.code(cookie);
    expect((await c.move({ code: first.code, document })).status).toBe(403);
    expect((await c.move({ code: second.code, document })).status).toBe(200);
  });
});

describe("using a code", () => {
  it("previews what the file holds and what the account holds now, and changes nothing", async () => {
    const c = await copy();
    const made = await c.code(await c.owner());
    const document = await file();
    const answer = await c.move({ code: made.code, document });
    const said = await answer.json() as { moved: boolean; counts: Record<string, number>; holds: Record<string, number>; confirm: string };
    expect(answer.status).toBe(200);
    expect(said).toMatchObject({ moved: false, confirm: "replace" });
    expect(said.counts.task).toBe(2);
    expect(said.holds.task ?? 0).toBe(0);
    expect(await c.tasks("owner")).toBe(0);
    expect(await c.store.pendingToken(await moveCodeId(made.code), "confirm")).not.toBeNull();
  });

  it("replaces on confirm, spends the code and answers counts, locked and ids", async () => {
    const c = await copy();
    const made = await c.code(await c.owner());
    const answer = await c.move({ code: made.code, document: await file(), confirm: "replace" });
    const done = await answer.json() as { counts: Record<string, number>; locked: unknown[]; ids: object };
    expect(answer.status).toBe(200);
    expect(done.counts.task).toBe(2);
    expect(Array.isArray(done.locked)).toBe(true);
    expect(Object.keys(done.ids).length).toBeGreaterThan(0);
    expect(await c.tasks("owner")).toBe(2);
    expect(c.publish).toHaveBeenCalledTimes(1);
  });

  it("works once", async () => {
    const c = await copy();
    const made = await c.code(await c.owner());
    const document = await file();
    expect((await c.move({ code: made.code, document, confirm: "replace" })).status).toBe(200);
    expect((await c.move({ code: made.code, document, confirm: "replace" })).status).toBe(403);
    expect((await c.move({ code: made.code, document })).status).toBe(403);
  });

  it("is refused once 15 minutes have passed", async () => {
    const c = await copy();
    const made = await c.code(await c.owner());
    c.advance(15 * 60_000 + 1_000);
    expect((await c.move({ code: made.code, document: await file(), confirm: "replace" })).status).toBe(403);
    expect(await c.tasks("owner")).toBe(0);
  });

  it("never reaches another account", async () => {
    const c = await copy();
    await c.owner();
    const cookie = await c.guest();
    const made = await c.code(cookie);
    expect((await c.move({ code: made.code, document: await file(), confirm: "replace" })).status).toBe(200);
    expect(await c.tasks("guest")).toBe(2);
    expect(await c.tasks("owner")).toBe(0);
  });

  it("takes no email or password", async () => {
    const c = await copy();
    const made = await c.code(await c.owner());
    const answer = await c.move({ code: made.code, email: "x@example.com", password: PASSWORD, document: await file(), confirm: "replace" });
    expect(answer.status).toBe(400);
    expect(await c.tasks("owner")).toBe(0);
  });

  it("refuses a plain cell under full encryption with the store's sentence, and keeps the code", async () => {
    const c = await copy();
    const made = await c.code(await c.owner());
    await c.db.db.prepare(`UPDATE account SET encryption = 'on' WHERE id = 'owner'`).run();
    const document = await file();
    const store = await c.store.checkRestore({ tables: (document.tables as Record<string, Record<string, unknown>[]>) }, "owner");
    expect(store.ok).toBe(false);
    for (const confirm of [undefined, "replace"]) {
      const answer = await c.move({ code: made.code, document, ...(confirm === undefined ? {} : { confirm }) });
      expect(answer.status).toBe(store.ok ? 0 : store.status);
      expect((await answer.json() as { error: string }).error).toBe(store.ok ? "" : store.error);
    }
    expect(await c.tasks("owner")).toBe(0);
    expect(await c.store.pendingToken(await moveCodeId(made.code), "confirm")).not.toBeNull();
  });
});
