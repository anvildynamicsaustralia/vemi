import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import worker, { front } from "./index.js";
import type { FrontEnv } from "./index.js";
import { createRelay } from "./relay.js";

const ORIGIN = "https://front.example.test";

function parts() {
  const assets = { fetch: vi.fn(async () => new Response("a file")) };
  const relay = createRelay({
    secret: "signing-".repeat(4),
    day: { get: async () => null, put: async () => {} },
    now: () => new Date("2026-11-20T10:00:00Z"),
    fetch: async () => new Response("{}"),
    origin: ORIGIN,
  });
  return { assets, relay };
}

describe("the front", () => {
  it("leaves / to the static files: the redirect to /get/ is the _redirects rule, tested in build-front.test.ts", async () => {
    const p = parts();
    expect(await (await front(new Request(`${ORIGIN}/`), p)).text()).toBe("a file");
    expect(p.assets.fetch).toHaveBeenCalledTimes(1);
  });

  it("runs the Worker only for the relay routes, so / never reaches it in production", () => {
    const config = readFileSync(join(process.cwd(), "wrangler.front.jsonc"), "utf8");
    expect(config).toMatch(/"run_worker_first":\s*\["\/get\/relay", "\/get\/relay\/\*"\]/);
  });

  it("hands every other path to the static files", async () => {
    const p = parts();
    for (const path of ["/get/", "/get/index.html", "/release/latest.json", "/release/0.1.0/manifest.json", "/anything"]) {
      expect(await (await front(new Request(`${ORIGIN}${path}`), p)).text()).toBe("a file");
    }
    expect(p.assets.fetch).toHaveBeenCalledTimes(5);
  });

  it("starts a setup and answers a preflight on the relay routes, and only takes POST", async () => {
    const p = parts();
    const start = await front(
      new Request(`${ORIGIN}/get/relay/start`, { method: "POST", headers: { "content-type": "application/json", origin: ORIGIN }, body: "{}" }),
      p,
    );
    expect(start.status).toBe(200);
    const pre = await front(new Request(`${ORIGIN}/get/relay`, { method: "OPTIONS", headers: { origin: ORIGIN } }), p);
    expect(pre.status).toBe(204);
    expect((await front(new Request(`${ORIGIN}/get/relay`), p)).status).toBe(405);
    expect(p.assets.fetch).not.toHaveBeenCalled();
  });

  it("switches the relay off when no signing key is set", async () => {
    const env = { ASSETS: parts().assets, RELAY_DAY: { get: async () => null, put: async () => {} } } as unknown as FrontEnv;
    const reply = await worker.fetch(new Request(`${ORIGIN}/get/relay/start`, { method: "POST" }), env);
    expect(reply.status).toBe(503);
  });

  it("builds the relay from the env when a signing key is set", async () => {
    const env = { ASSETS: parts().assets, RELAY_DAY: { get: async () => null, put: async () => {} }, FRONT_SIGNING_KEY: "signing-".repeat(4) } as unknown as FrontEnv;
    const reply = await worker.fetch(
      new Request(`${ORIGIN}/get/relay/start`, { method: "POST", headers: { "content-type": "application/json", origin: ORIGIN }, body: "{}" }),
      env,
    );
    expect(reply.status).toBe(200);
  });
});
