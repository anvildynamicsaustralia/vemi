import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Change } from "@vemi/shared";
import { createApp, type App } from "./app.js";
import { accountIdentity } from "./accountIdentity.js";
import { openStore, type Store } from "./store.js";
import { testDb, type TestDb } from "./testing/d1.js";

/** POST /mcp through the real app, a real D1 and a real token. */

const ORIGIN = "https://vemi.example.workers.dev";
const NOW = new Date("2026-11-18T02:00:00Z");
const MODERN = "2026-07-28";
const META = "io.modelcontextprotocol/protocolVersion";

let t: TestDb;
let store: Store;
let app: App;
const heard: { owner: string; change: Change }[] = [];

beforeAll(async () => {
  t = await testDb();
  store = openStore({ DB: t.db }, () => NOW);
  app = createApp({
    store, now: () => NOW, origin: ORIGIN, timeZone: "Australia/Sydney",
    identity: accountIdentity({
      store, now: () => NOW, origin: ORIGIN, owner: "the-operator", operatorEmail: "",
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

async function person() {
  const owner = `owner-${crypto.randomUUID()}`;
  expect(await store.createAccount({ id: owner, email: `${owner}@example.test`, passwordHash: "x", googleSub: null, confirmed: true })).toBe(true);
  const token = `token-${crypto.randomUUID()}`;
  await store.issueGrant(owner, { clientId: "client-1", tokenHash: await sha(token), refreshHash: await sha(`r-${token}`), expiresAt: "2026-11-18T03:00:00.000Z" });
  const space = await store.create(owner, "ventures", { name: "Workshop" });
  if (!space.ok) throw new Error(space.error);
  const post = (body: unknown, headers: Record<string, string> = {}, bearer: string | null = token) => app(
    new Request(`${ORIGIN}/mcp`, {
      method: "POST", body: typeof body === "string" ? body : JSON.stringify(body),
      headers: { "content-type": "application/json", ...(bearer === null ? {} : { authorization: `Bearer ${bearer}` }), ...headers },
    }),
    () => {},
  );
  return { owner, token, spaceId: space.value.record.id, post };
}

const modern = (id: number, method: string, params: Record<string, unknown> = {}) => ({
  body: { jsonrpc: "2.0", id, method, params: { ...params, _meta: { [META]: MODERN } } },
  headers: { "mcp-protocol-version": MODERN, "mcp-method": method, ...(method === "tools/call" ? { "mcp-name": String(params.name) } : {}) },
});

describe("POST /mcp", () => {
  it("answers 401 with where to find the sign-in, to no token and to a wrong one", async () => {
    const p = await person();
    for (const bearer of [null, "not-a-token"]) {
      const r = await p.post({ jsonrpc: "2.0", id: 1, method: "ping" }, {}, bearer);
      expect(r.status).toBe(401);
      expect(r.headers.get("www-authenticate")).toContain("resource_metadata=");
    }
  });

  it("refuses GET and a foreign Origin, and acknowledges a notification", async () => {
    const p = await person();
    const get = await app(new Request(`${ORIGIN}/mcp`, { headers: { authorization: `Bearer ${p.token}` } }), () => {});
    expect(get.status).toBe(405);
    expect((await p.post({ jsonrpc: "2.0", id: 1, method: "ping" }, { origin: "https://evil.example" })).status).toBe(403);
    const note = await p.post({ jsonrpc: "2.0", method: "notifications/initialized" });
    expect(note.status).toBe(202);
    expect(await note.text()).toBe("");
    expect((await p.post("{nope")).status).toBe(400);
    expect((await p.post([{ jsonrpc: "2.0", id: 1, method: "ping" }])).status).toBe(400);
  });

  it("answers the legacy handshake and then serves tools without a session", async () => {
    const p = await person();
    const init = await (await p.post({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "c", version: "1" } } })).json() as any;
    expect(init.result.protocolVersion).toBe("2025-06-18");
    expect(init.result.capabilities).toEqual({ tools: {} });
    expect(init.result.serverInfo.name).toBe("VEMI");
    const listed = await (await p.post({ jsonrpc: "2.0", id: 2, method: "tools/list" })).json() as any;
    expect(listed.result.tools.map((x: { name: string }) => x.name)).toContain("add_task");
  });

  it("serves the 2026-07-28 era: discover, list and call, with its headers checked", async () => {
    const p = await person();
    const disc = modern(1, "server/discover");
    const d = await (await p.post(disc.body, disc.headers)).json() as any;
    expect(d.result.supportedVersions).toContain(MODERN);
    expect(d.result.resultType).toBe("complete");

    const list = modern(2, "tools/list");
    const l = await (await p.post(list.body, list.headers)).json() as any;
    expect(l.result.tools).toHaveLength(12);

    const call = modern(3, "tools/call", { name: "add_task", arguments: { title: "Over the wire", space: "Workshop" } });
    heard.length = 0;
    const c = await (await p.post(call.body, call.headers)).json() as any;
    expect(c.result.isError).toBeUndefined();
    const made = JSON.parse(c.result.content[0].text);
    expect(made.title).toBe("Over the wire");
    expect((await store.get(p.owner, "tasks", made.id))?.title).toBe("Over the wire");
    expect(heard).toEqual([{ owner: p.owner, change: { kind: "tasks", id: made.id, ventureId: p.spaceId, via: "connector" } }]);
  });

  it("refuses mismatched headers and an unsupported version with the codes the spec names", async () => {
    const p = await person();
    const call = modern(1, "tools/call", { name: "today" });
    const wrongName = await p.post(call.body, { ...call.headers, "mcp-name": "overview" });
    expect(wrongName.status).toBe(400);
    expect(((await wrongName.json()) as any).error.code).toBe(-32020);
    expect((await p.post(call.body, {})).status).toBe(400);
    const old = { ...call.body, params: { ...call.body.params, _meta: { [META]: "1900-01-01" } } };
    const r = await p.post(old, { ...call.headers, "mcp-protocol-version": "1900-01-01" });
    expect(r.status).toBe(400);
    const e = ((await r.json()) as any).error;
    expect(e.code).toBe(-32022);
    expect(e.data.supported).toContain(MODERN);
    const unknown = modern(2, "resources/list");
    const u = await p.post(unknown.body, unknown.headers);
    expect(u.status).toBe(404);
    expect(((await u.json()) as any).error.code).toBe(-32601);
  });

  it("gives a plain error for a bad tool input and a protocol error for an unknown tool", async () => {
    const p = await person();
    const bad = await (await p.post({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "add_task", arguments: {} } })).json() as any;
    expect(bad.result).toEqual({ content: [{ type: "text", text: "title is needed" }], isError: true });
    const none = await (await p.post({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "delete_task", arguments: {} } })).json() as any;
    expect(none.error.code).toBe(-32602);
  });

  it("acts only for the token's account", async () => {
    const a = await person();
    const b = await person();
    const make = await (await b.post({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "add_task", arguments: { title: "Private thing", space: "Workshop" } } })).json() as any;
    const theirs = JSON.parse(make.result.content[0].text);
    const peek = await (await a.post({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "get_task", arguments: { task: theirs.id } } })).json() as any;
    expect(peek.result.isError).toBe(true);
    const found = await (await a.post({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "search", arguments: { text: "Private" } } })).json() as any;
    expect(JSON.parse(found.result.content[0].text)).toEqual([]);
  });

  it("carries the security headers", async () => {
    const p = await person();
    const r = await p.post({ jsonrpc: "2.0", id: 1, method: "ping" });
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
    expect(r.headers.get("cache-control")).toBe("no-store");
  });
});

describe("POST /mcp reads the account's own words and zone", () => {
  const descriptions = async (p: Awaited<ReturnType<typeof person>>): Promise<string> => {
    const listed = await (await p.post({ jsonrpc: "2.0", id: 1, method: "tools/list" })).json() as any;
    return JSON.stringify(listed.result.tools);
  };

  it("says the owner's renamed levels in tools/list, with their plurals, and only to that owner", async () => {
    const a = await person();
    const b = await person();
    expect((await store.setAppearance(a.owner, { levelNames: { space: "Study", task: "Step" } })).ok).toBe(true);
    const mine = await descriptions(a);
    expect(mine).toContain("each study");
    expect(mine).toContain("steps picked for today");
    expect(mine).toContain("studies, projects, milestones, steps and notes");
    expect(mine).not.toContain("Lists each space");
    const theirs = await descriptions(b);
    expect(theirs).toContain("Lists each space");
    expect(theirs).toContain("tasks picked for today");
    expect(theirs).not.toContain("study");
  });

  it("reads a rename on the next request, and says it in a refusal", async () => {
    const p = await person();
    expect(await descriptions(p)).toContain("Lists each space");
    await store.setAppearance(p.owner, { levelNames: { space: "Class", task: "Step" } });
    expect(await descriptions(p)).toContain("classes, projects");
    const gone = await (await p.post({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "get_task", arguments: { task: "nope" } } })).json() as any;
    expect(gone.result.content[0].text).toBe("step nope was not found");
  });

  it("reads the day in the account's zone when the call names none", async () => {
    const p = await person();
    const on = async (given: Record<string, unknown> = {}): Promise<string> => {
      const r = await (await p.post({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "today", arguments: given } })).json() as any;
      return JSON.parse(r.result.content[0].text).on;
    };
    // 02:00 UTC on the 18th is the 18th in Sydney and the 17th in Honolulu.
    expect(await on()).toBe("2026-11-18");
    await store.setAppearance(p.owner, { timeZone: "Pacific/Honolulu" });
    expect(await on()).toBe("2026-11-17");
    expect(await on({ timeZone: "Australia/Sydney" })).toBe("2026-11-18");
  });
});
