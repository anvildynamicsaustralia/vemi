import { describe, expect, it } from "vitest";
import { installBridge, serve, type WireRequest, type WireResponse } from "./bridge.js";

const ORIGIN = "https://vemi.test";
const bytes = (text: string): ArrayBuffer => new TextEncoder().encode(text).buffer as ArrayBuffer;

function rig(answer: (wire: WireRequest) => Promise<WireResponse> | WireResponse = () => ({ status: 200, headers: [["content-type", "application/json"]], body: bytes("{}") })) {
  const sent: WireRequest[] = [];
  const real: string[] = [];
  const target = { fetch: (async (input: unknown) => { real.push(String(input)); return new Response("real"); }) as typeof fetch };
  const restore = installBridge({ origin: ORIGIN, target, send: async (wire) => { sent.push(wire); return answer(wire); } });
  return { target, sent, real, restore };
}

describe("the page's fetch", () => {
  it("carries a same-origin /api/ and /auth/ request to the database and back", async () => {
    const r = rig((wire) => ({ status: 201, headers: [["content-type", "application/json"], ["x-seen", wire.method]], body: bytes('{"ok":true}') }));
    const response = await r.target.fetch("/api/tasks", { method: "POST", headers: { "content-type": "application/json" }, body: '{"title":"a"}' });
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ ok: true });
    expect(response.headers.get("x-seen")).toBe("POST");
    expect(r.sent).toHaveLength(1);
    expect(r.sent[0]).toMatchObject({ method: "POST", url: `${ORIGIN}/api/tasks` });
    expect(new TextDecoder().decode(r.sent[0]!.body!)).toBe('{"title":"a"}');
    expect(r.sent[0]!.headers.find(([k]) => k === "content-type")?.[1]).toBe("application/json");

    await r.target.fetch(`${ORIGIN}/auth/me`);
    await r.target.fetch(new Request(`${ORIGIN}/api/today?tz=UTC`));
    await r.target.fetch(new URL(`${ORIGIN}/api/search?q=a`));
    expect(r.sent.map((w) => w.url)).toEqual([`${ORIGIN}/api/tasks`, `${ORIGIN}/auth/me`, `${ORIGIN}/api/today?tz=UTC`, `${ORIGIN}/api/search?q=a`]);
    expect(r.sent[1]!.body).toBeNull();
    expect(r.real).toEqual([]);
  });

  it("answers a status with no body, and keeps a keepalive write harmless", async () => {
    const r = rig(() => ({ status: 204, headers: [], body: new ArrayBuffer(0) }));
    const response = await r.target.fetch("/api/tasks/a", { method: "PATCH", keepalive: true, body: "{}" });
    expect(response.status).toBe(204);
    expect(await response.text()).toBe("");
  });

  it("fails everything else with a TypeError, as an offline fetch does, and nothing leaves", async () => {
    const r = rig();
    const blocked = [
      "https://example.com/api/tasks", "https://api.github.com/repos/x/y", `${ORIGIN}/mcp`, `${ORIGIN}/oauth/token`,
      `${ORIGIN}/oauth/authorize`, `${ORIGIN}/setup/claim`, `${ORIGIN}/api/connector/grants`, `${ORIGIN}/api/push/act`,
      `${ORIGIN}/api/push`, `${ORIGIN}/get/`, `${ORIGIN}/sw.js`, `${ORIGIN}/.well-known/oauth-authorization-server`,
      "/mcp", "/oauth/register", "/setup/x", "/api/connector/client", "/api/push/subscribe", "//example.com/api/tasks",
    ];
    for (const url of blocked) {
      await expect(r.target.fetch(url), url).rejects.toBeInstanceOf(TypeError);
    }
    await expect(r.target.fetch(`${ORIGIN}.evil.test/api/tasks`)).rejects.toBeInstanceOf(TypeError);
    expect(r.sent).toEqual([]);
    expect(r.real).toEqual([]);
  });

  it("refuses an aborted request, before it is sent and while it waits", async () => {
    const r = rig(() => new Promise<WireResponse>(() => undefined));
    const early = new AbortController();
    early.abort();
    await expect(r.target.fetch("/api/tasks", { signal: early.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(r.sent).toHaveLength(0);
    const late = new AbortController();
    const waiting = r.target.fetch("/api/tasks", { signal: late.signal });
    late.abort();
    await expect(waiting).rejects.toMatchObject({ name: "AbortError" });
  });

  it("puts the real fetch back", async () => {
    const r = rig();
    const bridged = r.target.fetch;
    r.restore();
    expect(r.target.fetch).not.toBe(bridged);
    expect(await (await r.target.fetch("https://example.com/")).text()).toBe("real");
  });
});

describe("the database's side of the wire", () => {
  it("runs a wire request through a handler and returns a wire response", async () => {
    const handle = serve(async (request) => new Response(`${request.method} ${new URL(request.url).pathname} ${await request.text()}`, {
      status: 202, headers: { "x-a": "b" },
    }));
    const answer = await handle({ method: "POST", url: `${ORIGIN}/api/x`, headers: [["content-type", "text/plain"]], body: bytes("hi") });
    expect(answer.status).toBe(202);
    expect(new TextDecoder().decode(answer.body)).toBe("POST /api/x hi");
    expect(answer.headers).toContainEqual(["x-a", "b"]);
  });

  it("a GET has no body to carry", async () => {
    const handle = serve(async (request) => new Response(request.body === null ? "none" : "some"));
    const answer = await handle({ method: "GET", url: `${ORIGIN}/api/x`, headers: [], body: null });
    expect(new TextDecoder().decode(answer.body)).toBe("none");
  });
});
