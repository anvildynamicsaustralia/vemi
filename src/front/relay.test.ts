import { afterEach, describe, expect, it, vi } from "vitest";
import { ALLOWED, BUSY, MAX_BODY_BYTES, DAY_REQUESTS, RELAY_BUDGET, createRelay, readTicket, signTicket, target, ticketCap } from "./relay.js";
import type { KeyValue } from "./relay.js";

const ORIGIN = "https://front.example.test";
const SECRET = "signing-".repeat(4);
// The visitor's key, built so no key-shaped string sits in the file.
const TOKEN = ["tk", "visitor", "x".repeat(24)].join("_");
const SESSION = ["sess", "y".repeat(24)].join("_");

class Memory implements KeyValue {
  data = new Map<string, string>();
  puts = 0;
  async get(key: string) {
    return this.data.get(key) ?? null;
  }
  async put(key: string, value: string) {
    this.puts++;
    this.data.set(key, value);
  }
}

function setup(now = new Date("2026-11-20T10:00:00Z")) {
  const day = new Memory();
  const sent: { url: string; init: RequestInit }[] = [];
  const upstream = vi.fn(async (url: string, init: RequestInit) => {
    sent.push({ url, init });
    return new Response(JSON.stringify({ success: true, result: [] }), { status: 200, headers: { "set-cookie": "a=b", "content-type": "application/json" } });
  });
  const clock = { now };
  const waits: number[] = [];
  const wait = async (ms: number) => void waits.push(ms);
  const relay = createRelay({ secret: SECRET, day, now: () => clock.now, fetch: upstream, origin: ORIGIN, wait });
  return { relay, day, sent, upstream, clock, waits, wait };
}

const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  new Request(`${ORIGIN}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: ORIGIN, "cf-connecting-ip": "10.1.1.1", ...headers },
    body: JSON.stringify(body),
  });

async function ticketFrom(relay: ReturnType<typeof setup>["relay"]): Promise<string> {
  const reply = await relay.start(post("/get/relay/start", {}));
  return ((await reply.json()) as { ticket: string }).ticket;
}

afterEach(() => vi.restoreAllMocks());

describe("the allow-list", () => {
  it("is exactly the calls the setup client makes", () => {
    expect(ALLOWED.map((a) => `${a.method} ${a.path}`)).toEqual([
      "GET /user/tokens/verify",
      "GET /accounts",
      "GET /accounts/:id/workers/subdomain",
      "PUT /accounts/:id/workers/subdomain",
      "GET /accounts/:id/d1/database",
      "POST /accounts/:id/d1/database",
      "POST /accounts/:id/d1/database/:id/query",
      "POST /accounts/:id/workers/scripts/:id/assets-upload-session",
      "POST /accounts/:id/workers/assets/upload",
      "GET /accounts/:id/workers/scripts/:id/settings",
      "PUT /accounts/:id/workers/scripts/:id",
      "GET /accounts/:id/workers/scripts/:id/schedules",
      "PUT /accounts/:id/workers/scripts/:id/schedules",
      "GET /accounts/:id/workers/scripts/:id/subdomain",
      "POST /accounts/:id/workers/scripts/:id/subdomain",
    ]);
  });

  it("maps each listed call to api.cloudflare.com and nowhere else", () => {
    expect(target("GET", "/user/tokens/verify")).toBe("https://api.cloudflare.com/client/v4/user/tokens/verify");
    expect(target("GET", "/accounts?per_page=50")).toBe("https://api.cloudflare.com/client/v4/accounts?per_page=50");
    expect(target("put", "/accounts/abc123/workers/scripts/my-copy/schedules")).toBe(
      "https://api.cloudflare.com/client/v4/accounts/abc123/workers/scripts/my-copy/schedules",
    );
    expect(target("POST", "/accounts/abc123/workers/assets/upload?base64=true")).toContain("assets/upload?base64=true");
    for (const a of ALLOWED) {
      const path = a.path.replaceAll(":id", "one");
      expect(target(a.method, path)?.startsWith("https://api.cloudflare.com/client/v4/")).toBe(true);
    }
  });

  it("refuses a path outside the list, a wrong method, and a stray query", () => {
    expect(target("GET", "/accounts/abc/workers/scripts")).toBeNull();
    expect(target("DELETE", "/accounts/abc/workers/scripts/x")).toBeNull();
    expect(target("DELETE", "/user/tokens/verify")).toBeNull();
    expect(target("POST", "/user/tokens/verify")).toBeNull();
    expect(target("GET", "/user/tokens")).toBeNull();
    expect(target("GET", "/user/tokens/verify?x=1")).toBeNull();
    expect(target("GET", "/accounts?per_page=50&x=1")).toBeNull();
    expect(target("GET", "/zones")).toBeNull();
    expect(target("GET", 5)).toBeNull();
    expect(target(undefined, "/accounts")).toBeNull();
  });

  it("refuses a path that escapes through .. or an encoded slash", () => {
    const attempts = [
      "/accounts/../user/tokens",
      "/accounts/abc/workers/scripts/../../../../user/tokens/verify",
      "/accounts/%2e%2e/workers/subdomain",
      "/accounts/%2E%2E/workers/subdomain",
      "/accounts/abc%2Fworkers/subdomain",
      "/accounts/abc%2fworkers/subdomain",
      "/accounts/abc%5cworkers/subdomain",
      "/accounts/abc\\workers/subdomain",
      "/accounts/./workers/subdomain",
      "//accounts",
      "/accounts//workers/subdomain",
      "/accounts/abc/workers/subdomain#x",
      "/accounts/abc/workers/subdomain/",
      "accounts",
      "/accounts/a b/workers/subdomain",
    ];
    for (const path of attempts) expect(target("GET", path), path).toBeNull();
  });

  it("refuses another address, whatever the path says", () => {
    const attempts = [
      "https://evil.example.test/client/v4/accounts",
      "//evil.example.test/accounts",
      "/accounts@x.test/workers/subdomain",
      "@evil.example.test/accounts",
      "/accounts/abc:80/workers/subdomain",
    ];
    for (const path of attempts) expect(target("GET", path), path).toBeNull();
  });
});

describe("tickets and the cap", () => {
  it("signs, reads back and refuses a forged, wrong-day or out-of-time ticket", async () => {
    const now = new Date("2026-11-20T10:00:00Z");
    const ticket = { id: "t1", day: "2026-11-20", exp: now.getTime() + 60_000, budget: 5 };
    const text = await signTicket(SECRET, ticket);
    expect(await readTicket(SECRET, text, now)).toEqual(ticket);
    expect(await readTicket("other-".repeat(6), text, now)).toBeNull();
    expect(await readTicket(SECRET, text.replace(/.$/, (c) => (c === "A" ? "B" : "A")), now)).toBeNull();
    expect(await readTicket(SECRET, `${text}.x`, now)).toBeNull();
    expect(await readTicket(SECRET, "", now)).toBeNull();
    expect(await readTicket(SECRET, undefined, now)).toBeNull();
    expect(await readTicket(SECRET, text, new Date("2026-11-21T00:00:01Z"))).toBeNull();
    expect(await readTicket(SECRET, text, new Date(now.getTime() + 61_000))).toBeNull();
  });

  it("holds the day cap at the request allowance over the budget, never above KV's writes", () => {
    expect(ticketCap(RELAY_BUDGET)).toBe(Math.floor(40_000 / RELAY_BUDGET));
    expect(ticketCap(10)).toBe(1000);
    expect(ticketCap(100)).toBe(400);
  });

  it("counts each ticket in RELAY_DAY and stops with the busy message at the cap", async () => {
    const { relay, day, clock } = setup();
    const cap = ticketCap();
    day.data.set("tickets:2026-11-20", String(cap - 1));
    expect((await relay.start(post("/get/relay/start", {}, { "cf-connecting-ip": "10.0.0.1" }))).status).toBe(200);
    expect(day.data.get("tickets:2026-11-20")).toBe(String(cap));
    const refused = await relay.start(post("/get/relay/start", {}, { "cf-connecting-ip": "10.0.0.2" }));
    expect(refused.status).toBe(429);
    expect(((await refused.json()) as { error: string }).error).toBe(BUSY);
    expect(BUSY).toContain("Setup is busy today. Try tomorrow, or use the Deploy button");
    expect(day.data.get("tickets:2026-11-20")).toBe(String(cap));
    // The next UTC day starts a fresh count.
    clock.now = new Date("2026-11-21T00:00:05Z");
    expect((await relay.start(post("/get/relay/start", {}, { "cf-connecting-ip": "10.0.0.3" }))).status).toBe(200);
    expect(day.data.get("tickets:2026-11-21")).toBe("1");
  });

  it("retries a refused counter write once, after a pause, and still issues the ticket", async () => {
    const { relay, day, waits } = setup();
    let failures = 1;
    const put = day.put.bind(day);
    day.put = async (key, value) => {
      if (failures-- > 0) throw new Error("KV put failed: 429 Too Many Requests");
      await put(key, value);
    };
    const reply = await relay.start(post("/get/relay/start", {}, { "cf-connecting-ip": "10.0.0.4" }));
    expect(reply.status).toBe(200);
    expect(day.data.get("tickets:2026-11-20")).toBe("1");
    expect(waits).toHaveLength(1);
  });

  it("answers the busy message, not a 500, when the counter write is refused twice", async () => {
    const { relay, day } = setup();
    let tries = 0;
    day.put = async () => {
      tries++;
      throw new Error("KV put failed: 429 Too Many Requests");
    };
    const reply = await relay.start(post("/get/relay/start", {}, { "cf-connecting-ip": "10.0.0.5" }));
    expect(reply.status).toBe(429);
    expect(((await reply.json()) as { error: string }).error).toBe(BUSY);
    expect(tries).toBe(2);
    expect(day.data.size).toBe(0);
  });

  it("answers the busy message when the counter cannot be read", async () => {
    const { relay, day } = setup();
    day.get = async () => {
      throw new Error("KV get failed");
    };
    const reply = await relay.start(post("/get/relay/start", {}, { "cf-connecting-ip": "10.0.0.6" }));
    expect(reply.status).toBe(429);
    expect(((await reply.json()) as { error: string }).error).toBe(BUSY);
  });

  it("states its limit: spend is counted per isolate, so the cap is a count of honest setups", async () => {
    // Two instances stand for two isolates. A ticket replayed across them spends its budget in
    // each. The day cap counts tickets issued; it does not count calls. See the cap arithmetic.
    const one = setup();
    const two = setup();
    const ticket = await ticketFrom(one.relay);
    // A different address on each call, so the per-visitor courtesy limit is not what stops it.
    const call = (i: number) => post("/get/relay", { ticket, token: TOKEN, method: "GET", path: "/user/tokens/verify" }, { "cf-connecting-ip": `10.3.${Math.floor(i / 100)}.${i % 100}` });
    let allowed = 0;
    for (const { relay } of [one, two]) for (let i = 0; i < RELAY_BUDGET + 1; i++) if ((await relay.forward(call(i))).status === 200) allowed++;
    expect(allowed).toBe(RELAY_BUDGET * 2);
    // The arithmetic that holds for honest use: every ticket spent in full stays inside the day.
    expect(ticketCap() * RELAY_BUDGET).toBeLessThanOrEqual(DAY_REQUESTS);
  });

  it("limits each visitor by IP", async () => {
    const { relay } = setup();
    const codes: number[] = [];
    for (let i = 0; i < 7; i++) codes.push((await relay.start(post("/get/relay/start", {}, { "cf-connecting-ip": "10.9.9.9" }))).status);
    expect(codes.slice(0, 5)).toEqual([200, 200, 200, 200, 200]);
    expect(codes.slice(5)).toEqual([429, 429]);
    expect((await relay.start(post("/get/relay/start", {}, { "cf-connecting-ip": "10.9.9.8" }))).status).toBe(200);
  });
});

describe("the relay call", () => {
  it("forwards one allowed call with the key taken from the body", async () => {
    const { relay, sent } = setup();
    const ticket = await ticketFrom(relay);
    const reply = await relay.forward(post("/get/relay", { ticket, token: TOKEN, method: "POST", path: "/accounts/abc/d1/database", body: { name: "copy" } }));
    expect(reply.status).toBe(200);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.url).toBe("https://api.cloudflare.com/client/v4/accounts/abc/d1/database");
    expect(sent[0]!.init.method).toBe("POST");
    expect((sent[0]!.init.headers as Record<string, string>).authorization).toBe(`Bearer ${TOKEN}`);
    expect(sent[0]!.init.body).toBe(JSON.stringify({ name: "copy" }));
  });

  it("passes on an answer that has no body (204) without throwing", async () => {
    const { relay, upstream } = setup();
    upstream.mockResolvedValueOnce(new Response(null, { status: 204 }));
    const ticket = await ticketFrom(relay);
    const reply = await relay.forward(post("/get/relay", { ticket, token: TOKEN, method: "GET", path: "/user/tokens/verify" }));
    expect(reply.status).toBe(204);
    expect(await reply.text()).toBe("");
  });

  it("sends files as a form, and a session key in place of the account key for the upload", async () => {
    const { relay, sent } = setup();
    const ticket = await ticketFrom(relay);
    await relay.forward(
      post("/get/relay", {
        ticket,
        token: TOKEN,
        bearer: SESSION,
        method: "POST",
        path: "/accounts/abc/workers/assets/upload?base64=true",
        form: [{ name: "h1", type: "text/css", text: "Ym9keQ==" }],
      }),
    );
    expect(sent[0]!.init.body).toBeInstanceOf(FormData);
    expect((sent[0]!.init.headers as Record<string, string>).authorization).toBe(`Bearer ${SESSION}`);
  });

  it("refuses a call off the list without calling Cloudflare", async () => {
    const { relay, upstream } = setup();
    const ticket = await ticketFrom(relay);
    for (const path of ["/zones", "/accounts/../user/tokens", "/accounts/a%2Fb/workers/subdomain", "https://evil.example.test/x"]) {
      const reply = await relay.forward(post("/get/relay", { ticket, token: TOKEN, method: "GET", path }));
      expect(reply.status, path).toBe(400);
    }
    expect(upstream).not.toHaveBeenCalled();
  });

  it("refuses a ticket that is missing, bad or spent", async () => {
    const { relay, upstream, clock } = setup();
    const call = (ticket: unknown) => relay.forward(post("/get/relay", { ticket, token: TOKEN, method: "GET", path: "/user/tokens/verify" }));
    expect((await call(undefined)).status).toBe(403);
    expect((await call("not.a-ticket")).status).toBe(403);
    expect((await call(await signTicket("other-".repeat(6), { id: "z", day: "2026-11-20", exp: Date.now() + 1e9, budget: 9 }))).status).toBe(403);
    // Spent: a budget of two lasts two calls.
    const two = await signTicket(SECRET, { id: "two", day: "2026-11-20", exp: clock.now.getTime() + 60_000, budget: 2 });
    expect((await call(two)).status).toBe(200);
    expect((await call(two)).status).toBe(200);
    expect((await call(two)).status).toBe(403);
    expect(upstream).toHaveBeenCalledTimes(2);
    // Spent by the clock: yesterday's ticket.
    const old = await signTicket(SECRET, { id: "old", day: "2026-11-19", exp: clock.now.getTime() + 60_000, budget: 9 });
    expect((await call(old)).status).toBe(403);
  });

  it("limits each visitor's calls by IP", async () => {
    const { relay } = setup();
    const ticket = await signTicket(SECRET, { id: "many", day: "2026-11-20", exp: Date.now() + 1e10, budget: 100_000 });
    let refused = 0;
    for (let i = 0; i < 130; i++) {
      const reply = await relay.forward(post("/get/relay", { ticket, token: TOKEN, method: "GET", path: "/user/tokens/verify" }));
      if (reply.status === 429) refused++;
    }
    expect(refused).toBeGreaterThan(0);
  });

  it("sets no cookie and answers CORS for the page only, without credentials", async () => {
    const { relay } = setup();
    const ticket = await ticketFrom(relay);
    const reply = await relay.forward(post("/get/relay", { ticket, token: TOKEN, method: "GET", path: "/user/tokens/verify" }));
    expect(reply.headers.get("set-cookie")).toBeNull();
    expect(reply.headers.get("access-control-allow-origin")).toBe(ORIGIN);
    expect(reply.headers.get("access-control-allow-credentials")).toBeNull();
    const pre = relay.preflight(new Request(`${ORIGIN}/get/relay`, { method: "OPTIONS", headers: { origin: ORIGIN } }));
    expect(pre.status).toBe(204);
    expect(pre.headers.get("access-control-allow-origin")).toBe(ORIGIN);
    expect(pre.headers.get("access-control-allow-credentials")).toBeNull();
    const other = relay.preflight(new Request(`${ORIGIN}/get/relay`, { method: "OPTIONS", headers: { origin: "https://other.example.test" } }));
    expect(other.headers.get("access-control-allow-origin")).toBeNull();
    const foreign = await relay.forward(post("/get/relay", { ticket, token: TOKEN, method: "GET", path: "/user/tokens/verify" }, { origin: "https://other.example.test" }));
    expect(foreign.status).toBe(403);
    expect(foreign.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("never logs, stores or echoes the key", async () => {
    const spies = (["log", "info", "warn", "error", "debug", "trace"] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
    const { relay, day, upstream } = setup();
    // Cloudflare says the key back in an error, as a hostile or careless answer might.
    upstream.mockImplementationOnce(async () => new Response(JSON.stringify({ success: false, errors: [{ message: `bad ${TOKEN} and ${SESSION}` }] }), { status: 403 }));
    const ticket = await ticketFrom(relay);
    const seen: string[] = [];
    const take = async (reply: Response) => seen.push(await reply.clone().text(), JSON.stringify([...reply.headers]));
    take(await relay.start(post("/get/relay/start", {})));
    take(await relay.forward(post("/get/relay", { ticket, token: TOKEN, bearer: SESSION, method: "GET", path: "/user/tokens/verify" })));
    take(await relay.forward(post("/get/relay", { ticket, token: TOKEN, method: "GET", path: "/zones" })));
    take(await relay.forward(post("/get/relay", { ticket: "bad", token: TOKEN, method: "GET", path: "/user/tokens/verify" })));
    take(await relay.forward(post("/get/relay", { ticket, token: "short", method: "GET", path: "/user/tokens/verify" })));
    take(await relay.preflight(new Request(`${ORIGIN}/get/relay`, { method: "OPTIONS", headers: { origin: ORIGIN } })));
    for (const text of seen) {
      expect(text).not.toContain(TOKEN);
      expect(text).not.toContain(SESSION);
    }
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    expect(JSON.stringify([...day.data])).not.toContain(TOKEN);
  });

  it("refuses a call whose declared size is past the cap", async () => {
    const { relay } = setup();
    const ticket = await ticketFrom(relay);
    const request = post("/get/relay", { ticket, token: TOKEN, method: "GET", path: "/user/tokens/verify" }, { "content-length": String(MAX_BODY_BYTES + 1) });
    expect((await relay.forward(request)).status).toBe(413);
  });

  it("gives Cloudflare a time limit, and cuts the key out even as a JSON escape", async () => {
    const { relay, upstream } = setup();
    const ticket = await ticketFrom(relay);
    const quoted = ["tk", 'a"b', "x".repeat(12)].join("_");
    upstream.mockImplementationOnce(async () => new Response(JSON.stringify({ success: false, errors: [{ message: `bad ${quoted}` }] }), { status: 400 }));
    const reply = await relay.forward(post("/get/relay", { ticket, token: quoted, method: "GET", path: "/user/tokens/verify" }));
    expect(await reply.text()).not.toContain("x".repeat(12));
    const init = upstream.mock.calls.at(-1)?.[1] as RequestInit | undefined;
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });
});
