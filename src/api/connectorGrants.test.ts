import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp, type App } from "./app.js";
import { accountIdentity } from "./accountIdentity.js";
import { hashPassword } from "./password.js";
import { openStore, type Store } from "./store.js";
import { testDb, type TestDb } from "./testing/d1.js";

/** GET /api/connector/grants and the revoke route, through the real routes and a real D1. */

const ORIGIN = "https://vemi.example.workers.dev";
const PASSWORD = "a long enough password";
const NOW = new Date("2026-11-18T02:00:00Z");
const CLIENT = "client-1";

let t: TestDb;
let store: Store;
let app: App;
let passwordHash: string;

beforeAll(async () => {
  t = await testDb();
  passwordHash = await hashPassword(PASSWORD);
  store = openStore({ DB: t.db }, () => NOW);
  await store.registerClient({ id: CLIENT, name: "Claude", redirectUris: ["https://claude.ai/cb"] });
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

async function person() {
  const owner = `owner-${crypto.randomUUID()}`;
  const email = `${owner}@example.test`;
  expect(await store.createAccount({ id: owner, email, passwordHash, googleSub: null, confirmed: true })).toBe(true);
  let cookie = "";
  const call = (method: string, path: string, body?: unknown) => app(
    new Request(`${ORIGIN}${path}`, {
      method,
      headers: { origin: ORIGIN, ...(cookie ? { cookie } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    () => {},
  );
  const signedIn = await call("POST", "/auth/sign-in", { email, password: PASSWORD });
  cookie = (signedIn.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  return { owner, call };
}

const grant = (owner: string) => store.issueGrant(owner, {
  clientId: CLIENT, tokenHash: `t-${crypto.randomUUID()}`, refreshHash: `r-${crypto.randomUUID()}`,
  expiresAt: new Date(NOW.getTime() + 3600_000).toISOString(),
});

describe("connector grants", () => {
  it("lists a person's own, with no hash of any kind", async () => {
    const a = await person();
    const b = await person();
    const mine = await grant(a.owner);
    await grant(b.owner);
    const body = (await (await a.call("GET", "/api/connector/grants")).json()) as { grants: Record<string, unknown>[] };
    expect(body.grants).toHaveLength(1);
    expect(Object.keys(body.grants[0] ?? {}).sort()).toEqual(["clientName", "createdAt", "id", "lastUsedAt"]);
    expect(body.grants[0]?.id).toBe(mine.id);
  });

  it("revokes at once, and refuses another person's", async () => {
    const a = await person();
    const b = await person();
    const g = await grant(a.owner);
    expect((await b.call("POST", `/api/connector/grants/${g.id}/revoke`)).status).toBe(404);
    expect((await a.call("POST", `/api/connector/grants/${g.id}/revoke`)).status).toBe(200);
    const body = (await (await a.call("GET", "/api/connector/grants")).json()) as { grants: unknown[] };
    expect(body.grants).toEqual([]);
    expect((await a.call("POST", `/api/connector/grants/${g.id}/revoke`)).status).toBe(404);
  });
});
