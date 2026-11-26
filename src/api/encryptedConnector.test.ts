import { keysFrom, makeAccountKey, seal } from "@vemi/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { accountIdentity } from "./accountIdentity.js";
import { createApp, type App } from "./app.js";
import { openStore, type Store } from "./store.js";
import { testDb, type TestDb } from "./testing/d1.js";

/** The connector on an account with full encryption: every call is refused in one plain line, and nothing is written. */

const ORIGIN = "https://vemi.example.workers.dev";
const NOW = new Date("2026-11-19T02:00:00Z");
const LINE = "This VEMI is fully encrypted, so AI apps can't read it.";

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

async function setUp(to: "off" | "turning_on" | "on") {
  const owner = `owner-${crypto.randomUUID()}`;
  expect(await store.createAccount({ id: owner, email: `${owner}@example.test`, passwordHash: "x", googleSub: null, confirmed: true })).toBe(true);
  const token = `token-${crypto.randomUUID()}`;
  await store.issueGrant(owner, { clientId: "client-1", tokenHash: await sha(token), refreshHash: await sha(`r-${token}`), expiresAt: "2026-11-19T03:00:00.000Z" });
  // An account that is fully on holds nothing plain, so it can only be switched on while empty.
  let ventureId = "none";
  if (to !== "on") {
    const space = await store.create(owner, "ventures", { name: "Workshop" });
    if (!space.ok) throw new Error(space.error);
    ventureId = space.value.record.id;
  }
  if (to !== "off") {
    expect((await store.startEncryption(owner, "on")).ok).toBe(true);
    if (to === "on") expect((await store.finishEncryption(owner)).ok).toBe(true);
  }
  let n = 0;
  const rpc = async (method: string, params: Record<string, unknown>) => {
    const r = await app(new Request(`${ORIGIN}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++n, method, params }),
    }), () => {});
    return { status: r.status, raw: await r.text() };
  };
  return { owner, rpc, ventureId };
}

const count = async (table: string, owner: string): Promise<number> =>
  (await t.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE owner = ?`).bind(owner).first<{ n: number }>())?.n ?? 0;

describe("the connector on an encrypted account", () => {
  for (const state of ["on", "turning_on"] as const) {
    it(`refuses tools/list and every tools/call while ${state}, and writes nothing`, async () => {
      const s = await setUp(state);
      const list = await s.rpc("tools/list", {});
      expect(list.raw).toContain(LINE);
      expect(list.raw).not.toContain("get_project");
      for (const [name, args] of [
        ["add_task", { space: s.ventureId, title: "Should not exist" }],
        ["search", { text: "Workshop" }],
        ["add_project", { space: s.ventureId, name: "Nope" }],
      ] as const) {
        const call = await s.rpc("tools/call", { name, arguments: args });
        expect(call.raw, name).toContain(LINE);
      }
      expect(await count("task", s.owner)).toBe(0);
      expect(await count("project", s.owner)).toBe(0);
      expect(await count("connector_change", s.owner)).toBe(0);
    });
  }

  it("leaves a plain account's connector as it was", async () => {
    const s = await setUp("off");
    const list = await s.rpc("tools/list", {});
    expect(list.raw).not.toContain(LINE);
    expect(list.raw).toContain("tools");
  });
});

describe("the export of an encrypted account", () => {
  it("is the Worker's own: envelopes as stored, no plaintext, and the key rows", async () => {
    const s = await setUp("on");
    const { fieldKey, keyRef } = await keysFrom(makeAccountKey());
    const id = crypto.randomUUID();
    const name = await seal(fieldKey, keyRef, "Quokka Rota", { record: id, field: "name" });
    const made = await store.create(s.owner, "ventures", { id, name });
    expect(made.ok).toBe(true);
    const doc = await store.exportAll(s.owner, NOW);
    const text = JSON.stringify(doc);
    expect(text).toContain(name);
    expect(text).not.toContain("Quokka Rota");
    expect(Object.keys(doc.tables)).toContain("key_wrap");
  });
});
