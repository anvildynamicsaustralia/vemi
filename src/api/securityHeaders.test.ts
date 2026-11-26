import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp, type App } from "./app.js";
import { accountIdentity } from "./accountIdentity.js";
import { openStore } from "./store.js";
import { testDb, type TestDb } from "./testing/d1.js";

/** What every answer of the Worker carries, whatever route made it and whether it was a refusal. */

const ORIGIN = "https://vemi.example.workers.dev";
let t: TestDb;
let app: App;

beforeAll(async () => {
  t = await testDb();
  const store = openStore({ DB: t.db }, () => new Date("2026-11-20T02:00:00Z"));
  const now = () => new Date("2026-11-20T02:00:00Z");
  app = createApp({
    store, now, origin: ORIGIN, timeZone: "UTC",
    identity: accountIdentity({ store, now, origin: ORIGIN, owner: "o", operatorEmail: "", sessionSecret: "s", google: null, fetch: async () => { throw new Error("no network"); } }),
    live: { publish: async () => {}, connect: async () => new Response("x") },
  });
});
afterAll(() => t.dispose());

const ask = (method: string, path: string, headers: Record<string, string> = {}): Promise<Response> =>
  app(new Request(`${ORIGIN}${path}`, { method, headers, body: method === "GET" ? undefined : "{}" }), () => {});

describe("the Worker's own answers", () => {
  const paths: Array<[string, string]> = [
    ["GET", "/api/overview"], ["GET", "/api/front"], ["POST", "/api/ventures"], ["GET", "/auth/me"], ["POST", "/auth/sign-in"],
    ["GET", "/nothing"], ["GET", "/.well-known/oauth-authorization-server"], ["POST", "/oauth/token"], ["GET", "/mcp"],
    ["POST", "/oauth/register"],
  ];

  it("carry the full security header set", async () => {
    for (const [method, path] of paths) {
      const res = await ask(method, path, { "content-type": "application/json" });
      const label = `${method} ${path}`;
      expect(res.headers.get("x-content-type-options"), label).toBe("nosniff");
      expect(res.headers.get("referrer-policy"), label).toBe("no-referrer");
      expect(res.headers.get("x-frame-options"), label).toBe("DENY");
      expect(res.headers.get("strict-transport-security"), label).toMatch(/^max-age=\d{8,}$/);
      expect(res.headers.get("permissions-policy"), label).toContain("camera=()");
      expect(res.headers.get("cross-origin-resource-policy"), label).toBe("same-origin");
      expect(res.headers.get("content-security-policy"), label).toBe("default-src 'none'; frame-ancestors 'none'; base-uri 'none'");
    }
  });

  it("are never kept by a shared cache unless they are public metadata", async () => {
    for (const [method, path] of paths) {
      const res = await ask(method, path, { "content-type": "application/json" });
      const cache = res.headers.get("cache-control") ?? "";
      if (path.startsWith("/.well-known/")) expect(cache, path).toBe("public, max-age=3600");
      else expect(cache, `${method} ${path}`).toContain("no-store");
    }
  });
});
