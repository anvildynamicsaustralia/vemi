import { keysFrom, lockBinding, makeAccountKey, seal } from "@vemi/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { accountIdentity } from "./accountIdentity.js";
import { createApp, type App } from "./app.js";
import { openStore, type Store } from "./store.js";
import { testDb, type TestDb } from "./testing/d1.js";
import { parseCreate } from "./validate.js";

/** Locked content through the connector: the MCP route never answers an envelope or the words inside one. */

const ORIGIN = "https://vemi.example.workers.dev";
const NOW = new Date("2026-11-19T02:00:00Z");
const REFUSED = "That part is locked, so an AI app can't change it.";

let t: TestDb;
let store: Store;
let app: App;
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
    live: { publish: async () => {}, connect: async () => new Response("connected") },
  });
  await store.registerClient({ id: "client-1", name: "Claude", redirectUris: ["https://claude.example/cb"] });
});
afterAll(() => t.dispose());

const sha = async (s: string): Promise<string> =>
  [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)))].map((b) => b.toString(16).padStart(2, "0")).join("");

function good<T>(o: { ok: true; value: T } | { ok: false; error: string }): T {
  if (!o.ok) throw new Error(o.error);
  return o.value;
}

async function setUp() {
  const owner = `owner-${crypto.randomUUID()}`;
  expect(await store.createAccount({ id: owner, email: `${owner}@example.test`, passwordHash: "x", googleSub: null, confirmed: true })).toBe(true);
  const token = `token-${crypto.randomUUID()}`;
  await store.issueGrant(owner, { clientId: "client-1", tokenHash: await sha(token), refreshHash: await sha(`r-${token}`), expiresAt: "2026-11-19T03:00:00.000Z" });
  const { fieldKey, keyRef } = await keysFrom(makeAccountKey());
  const space = await store.create(owner, "ventures", { name: "Workshop" });
  if (!space.ok) throw new Error(space.error);
  const ventureId = space.value.record.id;
  const projectId = crypto.randomUUID();
  const taskId = crypto.randomUUID();
  const noteId = crypto.randomUUID();
  const secret = { brief: "zebrafinch plan", body: "quokka rota", note: "wombat sighting" };
  const whoFor = await seal(fieldKey, keyRef, secret.brief, lockBinding("projects", projectId, "whoFor"));
  const body = await seal(fieldKey, keyRef, secret.body, lockBinding("tasks", taskId, "body"));
  const note = await seal(fieldKey, keyRef, secret.note, lockBinding("notes", noteId, "body"));
  good(await store.create(owner, "projects", good(parseCreate("projects", { id: projectId, ventureId, name: "Shed", whoFor, doneLooks: "Plain and public" }))));
  good(await store.create(owner, "tasks", good(parseCreate("tasks", { id: taskId, ventureId, projectId, title: "Mend the gate", body }))));
  good(await store.create(owner, "notes", good(parseCreate("notes", { id: noteId, projectId, body: note }))));
  good(await store.create(owner, "notes", good(parseCreate("notes", { projectId, body: "an open note" }))));

  let n = 0;
  const call = async (name: string, args: Record<string, unknown>) => {
    const r = await app(new Request(`${ORIGIN}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++n, method: "tools/call", params: { name, arguments: args } }),
    }), () => {});
    const text = await r.text();
    const result = (JSON.parse(text) as { result: { isError?: boolean; content: { text: string }[] } }).result;
    return { raw: text, isError: result.isError === true, text: result.content[0]?.text ?? "" };
  };
  return { owner, call, projectId, taskId, noteId, whoFor, body, note, secret };
}

describe("the connector and locked content", () => {
  it("get_project answers locked in place of a sealed field and a sealed note, with no envelope or plaintext", async () => {
    const s = await setUp();
    const r = await s.call("get_project", { project: s.projectId });
    expect(r.isError).toBe(false);
    const out = JSON.parse(r.text) as { brief: Record<string, unknown>; notes: { id: string; body?: string; locked?: true }[] };
    expect(out.brief.whoFor).toEqual({ locked: true });
    expect(out.brief.doneLooks).toBe("Plain and public");
    expect(out.notes.find((x) => x.id === s.noteId)).toEqual({ id: s.noteId, locked: true });
    expect(out.notes.some((x) => x.body === "an open note")).toBe(true);
    for (const bad of [s.whoFor, s.body, s.note, ...Object.values(s.secret)]) expect(r.raw).not.toContain(bad);
  });

  it("get_task answers locked in place of a sealed body", async () => {
    const s = await setUp();
    const r = await s.call("get_task", { task: s.taskId });
    expect(r.isError).toBe(false);
    expect((JSON.parse(r.text) as { body: unknown }).body).toEqual({ locked: true });
    for (const bad of [s.body, s.secret.body]) expect(r.raw).not.toContain(bad);
  });

  it("update_brief refuses a sealed field and leaves it as it was", async () => {
    const s = await setUp();
    const r = await s.call("update_brief", { project: s.projectId, field: "whoFor", text: "overwritten" });
    expect(r.isError).toBe(true);
    expect(r.text).toBe(REFUSED);
    const mine = (await store.tree(s.owner)).ventures.flatMap((v) => v.projects).find((p) => p.id === s.projectId);
    expect(mine?.whoFor).toBe(s.whoFor);
    const open = await s.call("update_brief", { project: s.projectId, field: "doneLooks", text: "Plain again" });
    expect(open.isError).toBe(false);
    for (const bad of [s.whoFor, s.secret.brief]) expect(open.raw).not.toContain(bad);
    expect((JSON.parse(open.text) as { whoFor: unknown }).whoFor).toEqual({ locked: true });
  });

  it("update_task, complete_task and pick_for_today never answer a sealed body", async () => {
    const s = await setUp();
    for (const [name, args] of [
      ["update_task", { task: s.taskId, title: "Mend the gate again" }],
      ["pick_for_today", { task: s.taskId }],
      ["complete_task", { task: s.taskId }],
    ] as const) {
      const r = await s.call(name, args);
      expect(r.isError, `${name}: ${r.text}`).toBe(false);
      expect((JSON.parse(r.text) as { body: unknown }).body).toEqual({ locked: true });
      for (const bad of [s.body, s.secret.body]) expect(r.raw).not.toContain(bad);
    }
  });

  it("search and add_note never carry an envelope or the words inside one", async () => {
    const s = await setUp();
    for (const [name, args] of [["search", { query: "zebrafinch" }], ["add_note", { project: s.projectId, text: "fresh" }]] as const) {
      const r = await s.call(name, args);
      for (const bad of [s.whoFor, s.body, s.note, ...Object.values(s.secret)]) expect(r.raw).not.toContain(bad);
    }
  });
});
