/**
 * vemi-front: the front door. Static files for /get/ and /release/ come straight from assets
 * (free, and not counted against the Worker's daily requests). This Worker runs only for the
 * relay routes under /get/relay (wrangler.front.jsonc runs it for no other path). The front
 * / is the home page, a static file put there by scripts/build-front.mjs and tested there.
 *
 * No D1, no Durable Object, no cron. One KV namespace, RELAY_DAY, holds a count of tickets a day.
 */
import { createRelay } from "./relay.js";
import type { KeyValue } from "./relay.js";

export interface FrontEnv {
  ASSETS: { fetch(request: Request): Promise<Response> };
  RELAY_DAY: KeyValue;
  /** Signs tickets. Set by Andy with `wrangler secret put`; never in a file. */
  FRONT_SIGNING_KEY: string;
}

export interface FrontParts {
  relay: ReturnType<typeof createRelay> | null;
  assets: FrontEnv["ASSETS"];
}

/** Answers one request from its parts; the Worker below builds them from `env`. */
export async function front(request: Request, parts: FrontParts): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  if (path === "/get/relay/start" || path === "/get/relay") {
    const relay = parts.relay;
    if (relay === null) return new Response(JSON.stringify({ error: "Setup is not switched on here." }), { status: 503, headers: { "content-type": "application/json", "cache-control": "no-store" } });
    if (request.method === "OPTIONS") return relay.preflight(request);
    if (request.method !== "POST") return new Response(null, { status: 405, headers: { allow: "POST, OPTIONS" } });
    return path === "/get/relay" ? relay.forward(request) : relay.start(request);
  }
  return parts.assets.fetch(request);
}

export default {
  async fetch(request: Request, env: FrontEnv): Promise<Response> {
    const origin = new URL(request.url).origin;
    const relay =
      typeof env.FRONT_SIGNING_KEY === "string" && env.FRONT_SIGNING_KEY !== ""
        ? createRelay({
            secret: env.FRONT_SIGNING_KEY,
            day: env.RELAY_DAY,
            now: () => new Date(),
            fetch: (url, init) => fetch(url, init),
            origin,
          })
        : null;
    return front(request, { relay, assets: env.ASSETS });
  },
};
