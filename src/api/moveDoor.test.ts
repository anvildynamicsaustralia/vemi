import { afterEach, describe, expect, it, vi } from "vitest";
import { accountIdentity } from "./accountIdentity.js";
import { createApp } from "./app.js";
import { moveCodeId } from "./move.js";
import { sessionKey } from "./sessionKey.js";
import { createSetup } from "./setup.js";
import { openStore } from "./store.js";
import { testDb } from "./testing/d1.js";

/**
 * The move door on a fresh copy: `POST /setup/move` makes the owner and puts a file's rows in
 * it, once, for whoever holds the copy's code and speaks from the one origin it was built for.
 */

const ORIGIN = "https://vemi.example.workers.dev";
const FROM = "https://get.example.org";
const CODE = "a-setup-code-only-the-page-knows";
const PASSWORD = "correct horse battery";
const EMAIL = "me@example.com";

// Each copy boots its own database, which takes a while.
vi.setConfig({ testTimeout: 180_000 });

const disposers: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const d of disposers.splice(0)) await d();
  vi.useRealTimers();
});

async function copy(options: { claim?: string; from?: string; operator?: string; now?: () => Date } = {}) {
  const db = await testDb();
  disposers.push(() => db.dispose());
  const now = options.now ?? (() => new Date());
  const store = openStore({ DB: db.db }, now);
  const identity = accountIdentity({
    store, now, origin: ORIGIN, owner: "owner", operatorEmail: options.operator ?? "",
    sessionSecret: () => sessionKey(store), google: null, setupClaim: false,
    fetch: (async () => { throw new Error("no network"); }) as typeof fetch,
  });
  const publish = vi.fn(async () => {});
  const claim = options.claim ?? CODE;
  const app = createApp({
    store, identity, now, origin: ORIGIN, timeZone: "UTC", copyOwner: "owner",
    setup: createSetup({ store, secret: claim, from: options.from ?? FROM, origin: ORIGIN, move: { owner: "owner", identity, publish } }),
    live: { publish, connect: async () => new Response("connected") },
  });
  const call = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Response> =>
    app(new Request(`${ORIGIN}${path}`, {
      method,
      headers: { origin: ORIGIN, "cf-connecting-ip": "10.1.1.1", ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    }), () => {});
  const move = (body: unknown, origin: string | null = FROM): Promise<Response> =>
    app(new Request(`${ORIGIN}/setup/move`, {
      method: "POST",
      headers: { "content-type": "application/json", "cf-connecting-ip": "10.1.1.1", ...(origin === null ? {} : { origin }) },
      body: JSON.stringify(body),
    }), () => {});
  const owned = async (): Promise<boolean> => (await store.account("owner")) !== null;
  return { store, call, move, owned, publish, db };
}

/** An export file from a copy that has some stuff in it. */
let filed: Promise<{ document: Record<string, unknown>; counts: Record<string, number> }> | null = null;
const file = () => (filed ??= makeFile());

async function makeFile(): Promise<{ document: Record<string, unknown>; counts: Record<string, number> }> {
  const donor = await copy();
  const made = await donor.call("POST", "/auth/claim", { email: "donor@example.com", password: PASSWORD });
  const cookie = (made.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; ");
  const api = async (path: string, body?: unknown): Promise<Record<string, unknown>> =>
    (await donor.call(body === undefined ? "GET" : "POST", path, body, { cookie })).json() as Promise<Record<string, unknown>>;
  const space = await api("/api/ventures", { name: "Studios" });
  await api("/api/tasks", { ventureId: space.id, title: "First" });
  await api("/api/tasks", { ventureId: space.id, title: "Second" });
  const document = await api("/api/export");
  const tables = document.tables as Record<string, unknown[]>;
  await donor.db.dispose();
  return { document, counts: Object.fromEntries(Object.entries(tables).map(([k, v]) => [k, v.length])) };
}

const body = (document: unknown, extra: Record<string, unknown> = {}) => ({ code: CODE, email: EMAIL, password: PASSWORD, document, ...extra });

describe("the code", () => {
  it.each([["wrong", "not-the-code"], ["empty", ""], ["missing", undefined]])("refuses a %s code and writes nothing", async (_n, code) => {
    const c = await copy();
    const { document } = await file();
    const sent: Record<string, unknown> = body(document);
    if (code === undefined) delete sent.code;
    else sent.code = code;
    const answer = await c.move(sent);
    expect(answer.status).toBe(403);
    expect(await c.owned()).toBe(false);
  });

  it("works once for a fresh copy, then the copy has an owner and no second one is made", async () => {
    const c = await copy();
    const { document } = await file();
    expect((await c.move(body(document))).status).toBe(200);
    expect(await c.owned()).toBe(true);
    const second = await c.move(body(document, { email: "other@example.com" }));
    expect(second.status).toBe(200);
    expect(await second.json()).toMatchObject({ moved: false });
    const replace = await c.move(body(document, { email: "other@example.com", confirm: "replace" }));
    expect(replace.status).toBe(409);
    expect((await c.store.account("owner"))?.email).toBe(EMAIL);
  });

  it("is refused on a copy with no code, whatever is sent", async () => {
    const c = await copy({ claim: "" });
    const { document } = await file();
    expect((await c.move({ ...body(document), code: "" })).status).toBe(403);
    expect(await c.owned()).toBe(false);
  });
});

describe("the file", () => {
  it("is checked first: a file the store refuses leaves no owner", async () => {
    const c = await copy();
    const answer = await c.move(body({ format: "vemi-export", version: 2, tables: { secrets: [{ id: "x" }] } }));
    expect(answer.status).toBe(400);
    expect(await c.owned()).toBe(false);
  });

  it("lands with counts equal to the file's, and the room is told once", async () => {
    const c = await copy();
    const { document, counts } = await file();
    const answer = await c.move(body(document));
    const done = await answer.json() as { counts: Record<string, number>; recoveryCode: string; handOver: string; ids: object; locked: unknown[] };
    expect(answer.status).toBe(200);
    for (const [name, n] of Object.entries(counts)) {
      if (["account", "device", "push_subscription"].includes(name)) continue;
      expect(done.counts[name] ?? 0).toBe(n);
    }
    expect(done.recoveryCode).toMatch(/\S/);
    expect(done.handOver).toMatch(/\S/);
    expect(c.publish).toHaveBeenCalledTimes(1);
    const exported = await c.store.exportAll("owner", new Date());
    expect(Object.fromEntries(Object.entries(exported.tables).map(([k, v]) => [k, v.length]))).toMatchObject(
      Object.fromEntries(Object.entries(done.counts).filter(([, n]) => n > 0)),
    );
  });

  it("keeps the account and says one sentence when the restore fails after it was made", async () => {
    const c = await copy();
    const { document } = await file();
    vi.spyOn(c.store, "restoreAll").mockResolvedValue({ ok: false, status: 400, error: "internal detail" });
    const answer = await c.move(body(document));
    const said = await answer.json() as { error: string };
    expect(answer.status).toBe(400);
    expect(said.error).not.toContain("internal detail");
    expect(said.error.split(". ").length).toBeLessThanOrEqual(2);
    expect(await c.owned()).toBe(true);
    expect(c.publish).not.toHaveBeenCalled();
  });

  it("is too big past the cap, with nothing made", async () => {
    const c = await copy();
    const answer = await c.move(body({ format: "vemi-export", version: 2, tables: {}, pad: "x".repeat(21 * 1024 * 1024) }));
    expect(answer.status).toBe(413);
    expect(await c.owned()).toBe(false);
  });
});

describe("where it may come from", () => {
  it("gives CORS to the configured origin only, claimed or not", async () => {
    const c = await copy();
    const { document } = await file();
    const good = await c.move(body(document));
    expect(good.headers.get("access-control-allow-origin")).toBe(FROM);
    expect(good.headers.get("access-control-allow-credentials")).toBeNull();
    const after = await c.move(body(document));
    expect(after.headers.get("access-control-allow-origin")).toBe(FROM);
  });

  it("answers the preflight for the configured origin and gives nothing to another", async () => {
    const c = await copy();
    const ask = (origin: string) => c.call("OPTIONS", "/setup/move", undefined, { origin });
    const ok = await ask(FROM);
    expect(ok.status).toBe(204);
    expect(ok.headers.get("access-control-allow-origin")).toBe(FROM);
    const other = await ask("https://evil.example.org");
    expect(other.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("gives no header and writes nothing for another origin or none", async () => {
    const c = await copy();
    const { document } = await file();
    for (const origin of ["https://evil.example.org", `${FROM}/`, "null", null]) {
      const answer = await c.move(body(document), origin);
      expect(answer.status).toBe(403);
      expect(answer.headers.get("access-control-allow-origin")).toBeNull();
    }
    expect(await c.owned()).toBe(false);
  });

  it("does not exist on a copy with no SETUP_FROM", async () => {
    const c = await copy({ from: "" });
    const { document } = await file();
    expect((await c.move(body(document))).status).toBe(403);
    expect(await c.owned()).toBe(false);
  });

  it("leaves /api/restore refusing another origin", async () => {
    const c = await copy();
    const answer = await c.call("POST", "/api/restore", { document: {} }, { origin: FROM });
    expect(answer.status).toBe(403);
  });
});

describe("the hand-over", () => {
  it("signs in once, by a page with no Location header, and not again", async () => {
    const c = await copy();
    const { document } = await file();
    const done = await (await c.move(body(document))).json() as { handOver: string };
    const first = await c.call("GET", `/auth/move-in?t=${encodeURIComponent(done.handOver)}`);
    expect(first.status).toBe(200);
    expect(first.headers.get("location")).toBeNull();
    expect(first.headers.get("content-type")).toContain("text/html");
    expect(await first.text()).toContain('http-equiv="refresh"');
    const cookies = first.headers.getSetCookie();
    expect(cookies.some((x) => x.startsWith("__Host-vemi=") && x.includes("SameSite=Strict"))).toBe(true);
    const cookie = cookies.map((x) => x.split(";")[0]).join("; ");
    expect((await c.call("GET", "/auth/me", undefined, { cookie })).status).toBe(200);
    expect(await (await c.call("GET", "/auth/me", undefined, { cookie })).json()).toMatchObject({ signedIn: true });
    const again = await c.call("GET", `/auth/move-in?t=${encodeURIComponent(done.handOver)}`);
    expect(again.status).toBe(400);
    expect(again.headers.getSetCookie()).toEqual([]);
  });

  it("does not work after five minutes", async () => {
    let clock = Date.parse("2026-11-22T00:00:00Z");
    const c = await copy({ now: () => new Date(clock) });
    const { document } = await file();
    const done = await (await c.move(body(document))).json() as { handOver: string };
    clock += 5 * 60 * 1000 + 1000;
    const late = await c.call("GET", `/auth/move-in?t=${encodeURIComponent(done.handOver)}`);
    expect(late.status).toBe(400);
    expect(late.headers.getSetCookie()).toEqual([]);
  });

  it("is never opened by the owner's move code, which stays usable", async () => {
    const c = await copy();
    const { document } = await file();
    const done = await (await c.move(body(document))).json() as { handOver: string };
    const first = await c.call("GET", `/auth/move-in?t=${encodeURIComponent(done.handOver)}`);
    const cookie = first.headers.getSetCookie().map((x) => x.split(";")[0]).join("; ");
    const made = await (await c.call("POST", "/api/move-code", {}, { cookie })).json() as { code: string };
    const letters = made.code.replace(/-/g, "");
    const tried = await c.call("GET", `/auth/move-in?t=${encodeURIComponent(letters)}`);
    expect(tried.status).toBe(400);
    expect(tried.headers.getSetCookie()).toEqual([]);
    expect(await c.store.pendingToken(await moveCodeId(made.code), "confirm")).not.toBeNull();
  });

  it("lands on the finishing mark only when the move carried locked content", async () => {
    const c = await copy();
    const { document } = await file();
    const done = await (await c.move(body(document))).json() as { handOver: string };
    const page = await c.call("GET", `/auth/move-in?t=${encodeURIComponent(done.handOver)}&finish=1`);
    expect(await page.text()).toContain('url=/?finishing=1"');
    const plain = await copy();
    const again = await (await plain.move(body(document))).json() as { handOver: string };
    expect(await (await plain.call("GET", `/auth/move-in?t=${encodeURIComponent(again.handOver)}`)).text()).toContain('url=/"');
  });

  it("is not a thing a guess opens", async () => {
    const c = await copy();
    expect((await c.call("GET", "/auth/move-in?t=nope")).status).toBe(400);
    expect((await c.call("GET", "/auth/move-in")).status).toBe(400);
  });
});

describe("secrets", () => {
  it("keeps the code, password and file out of every log line, answer and export", async () => {
    const lines: string[] = [];
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(console, m).mockImplementation((...a: unknown[]) => { lines.push(a.map(String).join(" ")); }));
    const c = await copy();
    const { document } = await file();
    const answer = await c.move(body(document, { password: "unmistakable-password-9" }));
    const text = await answer.text();
    const exported = JSON.stringify(await c.store.exportAll("owner", new Date()));
    for (const spy of spies) spy.mockRestore();
    for (const secret of [CODE, "unmistakable-password-9"]) {
      expect(text).not.toContain(secret);
      expect(exported).not.toContain(secret);
      expect(lines.join("\n")).not.toContain(secret);
    }
    expect(lines.join("\n")).not.toContain("Studios");
    expect(text).not.toContain("Studios");
  });

  it("refuses an email the operator did not name, and makes nothing", async () => {
    const c = await copy({ operator: "operator@example.com" });
    const { document } = await file();
    expect((await c.move(body(document))).status).toBe(403);
    expect(await c.owned()).toBe(false);
  });

  it("refuses a short password, and makes nothing", async () => {
    const c = await copy();
    const { document } = await file();
    expect((await c.move(body(document, { password: "short" }))).status).toBe(400);
    expect(await c.owned()).toBe(false);
  });
});
