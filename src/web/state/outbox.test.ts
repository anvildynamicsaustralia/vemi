import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_QUEUED, apiFetch, clearOutbox, drain, enqueue, isNotNow, onWaiting, ownOutbox, queued, writesInFlight } from "./outbox.js";

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() { return values.size; },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (i) => [...values.keys()][i] ?? null,
    removeItem: (key) => { values.delete(key); },
    setItem: (key, value) => { values.set(key, String(value)); },
  };
}

const unreachable = (): Promise<Response> => Promise.reject(new TypeError("Failed to fetch"));
const answer = (status: number, body: unknown = {}) => (): Promise<Response> =>
  Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));

const A = "a@example.com";
const B = "b@example.com";

beforeEach(() => {
  vi.stubGlobal("localStorage", memoryStorage());
  ownOutbox(A);
});
afterEach(() => {
  ownOutbox(null);
  vi.unstubAllGlobals();
});

describe("apiFetch", () => {
  it("keeps a write it could not send and says it was accepted by this device", async () => {
    const response = await apiFetch("/api/tasks", { method: "POST", body: "{\"title\":\"a\"}" }, unreachable);
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ queued: true, waiting: 1 });
    expect(queued()).toMatchObject([{ url: "/api/tasks", method: "POST", body: "{\"title\":\"a\"}" }]);
  });

  it("hands a refusal straight back and keeps nothing", async () => {
    const response = await apiFetch("/api/tasks", { method: "POST", body: "{}" }, answer(400, { error: "title is required" }));
    expect(response.status).toBe(400);
    expect(queued()).toEqual([]);
  });

  it("says a write was not kept when the outbox is full, rather than that it was", async () => {
    for (let i = 0; i < MAX_QUEUED; i++) enqueue({ url: `/w${i}`, method: "POST", body: "{}" });
    const response = await apiFetch("/api/tasks", { method: "POST", body: "{}" }, unreachable);
    expect(response.status).toBe(507);
    expect(((await response.json()) as { error: string }).error).toContain("not kept");
    expect(queued()).toHaveLength(MAX_QUEUED);
  });

  it("counts writes on their way, and only writes", async () => {
    let release: (r: Response) => void = () => {};
    const pending = apiFetch("/api/tasks", { method: "POST", body: "{}" }, () => new Promise<Response>((r) => { release = r; }));
    void apiFetch("/api/tree", {}, answer(200));
    expect(writesInFlight()).toBe(1);
    release(new Response("{}", { status: 201 }));
    await pending;
    expect(writesInFlight()).toBe(0);
  });

  it("keeps nothing while nobody is known to be signed in, and fails as what it is", async () => {
    ownOutbox(null);
    await expect(apiFetch("/api/tasks", { method: "POST", body: "{}" }, unreachable)).rejects.toThrow("Failed to fetch");
    expect(queued()).toEqual([]);
  });

  it("never keeps a read", async () => {
    await expect(apiFetch("/api/tree", {}, unreachable)).rejects.toThrow("Failed to fetch");
    expect(queued()).toEqual([]);
  });
});

describe("drain", () => {
  it("sends oldest first and stops at the first it cannot reach, keeping the rest in order", async () => {
    enqueue({ url: "/one", method: "POST", body: "{}" });
    enqueue({ url: "/two", method: "PATCH", body: "{}" });
    enqueue({ url: "/three", method: "POST", body: null });
    const sent: string[] = [];
    const doFetch = vi.fn((url: string | URL | Request) => {
      if (String(url) === "/two") return unreachable();
      sent.push(String(url));
      return answer(200)();
    });
    expect(await drain(doFetch as unknown as typeof fetch)).toEqual({ sent: 1, refused: 0, left: 2, signedOut: false });
    expect(sent).toEqual(["/one"]);
    expect(queued().map((q) => q.url)).toEqual(["/two", "/three"]);
  });

  it("drops what the Worker refuses, with its reason, and carries on", async () => {
    enqueue({ url: "/refused", method: "POST", body: "{}" });
    enqueue({ url: "/fine", method: "POST", body: "{}" });
    const reasons: string[] = [];
    const doFetch = ((url: string) => (url === "/refused" ? answer(400, { error: "that venture is archived" })() : answer(201)())) as unknown as typeof fetch;
    expect(await drain(doFetch, (_entry, why) => reasons.push(why))).toEqual({ sent: 1, refused: 1, left: 0, signedOut: false });
    expect(reasons).toEqual(["that venture is archived"]);
    expect(queued()).toEqual([]);
  });

  it("does not call a 409 'not now': a refused write is said once and not kept", async () => {
    expect(isNotNow(409)).toBe(false);
    const sentence = "there is already a tag called that";
    enqueue({ url: "/tag", method: "POST", body: "{}" });
    enqueue({ url: "/next", method: "POST", body: "{}" });
    const reasons: string[] = [];
    const sent: string[] = [];
    const doFetch = ((url: string) => {
      sent.push(url);
      return url === "/tag" ? answer(409, { error: sentence })() : answer(201)();
    }) as unknown as typeof fetch;
    expect(await drain(doFetch, (_entry, why) => reasons.push(why))).toEqual({ sent: 1, refused: 1, left: 0, signedOut: false });
    expect(reasons).toEqual([sentence]);
    expect(sent).toEqual(["/tag", "/next"]);
    expect(queued()).toEqual([]);
  });

  it("keeps what the Worker cannot take right now: signed out, or broken for the moment", async () => {
    for (const status of [401, 503]) {
      enqueue({ url: `/kept-${status}`, method: "POST", body: "{}" });
      const reasons: string[] = [];
      const result = await drain(answer(status, { error: "not now" }) as unknown as typeof fetch, (_e, why) => reasons.push(why));
      expect(result).toEqual({ sent: 0, refused: 0, left: 1, signedOut: status === 401 });
      expect(reasons).toEqual([]);
      localStorage.clear();
    }
  });

  it("sends each write once when two drains are asked for together", async () => {
    enqueue({ url: "/once", method: "POST", body: "{}" });
    const doFetch = vi.fn(() => answer(201)());
    const [a, b] = await Promise.all([drain(doFetch as unknown as typeof fetch), drain(doFetch as unknown as typeof fetch)]);
    expect(doFetch).toHaveBeenCalledTimes(1);
    expect(a).toEqual(b);
    expect(queued()).toEqual([]);
  });

  it("sends a write queued while it was draining, and loses nothing", async () => {
    enqueue({ url: "/first", method: "POST", body: "{}" });
    const sent: string[] = [];
    const doFetch = vi.fn((url: string | URL | Request) => {
      if (String(url) === "/first") enqueue({ url: "/during", method: "PATCH", body: "{}" });
      sent.push(String(url));
      return answer(200)();
    });
    expect(await drain(doFetch as unknown as typeof fetch)).toEqual({ sent: 2, refused: 0, left: 0, signedOut: false });
    expect(sent).toEqual(["/first", "/during"]);
  });
});

describe("one account's writes", () => {
  it("are stamped with the account signed in when they were made", () => {
    enqueue({ url: "/mine", method: "POST", body: "{}" });
    expect(queued()).toMatchObject([{ url: "/mine", account: A }]);
  });

  it("are never sent as another account, and are discarded once another is signed in", async () => {
    enqueue({ url: "/a-made-this", method: "POST", body: "{\"name\":\"A's venture\"}" });
    enqueue({ url: "/a-again", method: "PATCH", body: "{}" });
    ownOutbox(null);
    const doFetch = vi.fn(() => answer(201)());
    expect(await drain(doFetch as unknown as typeof fetch)).toEqual({ sent: 0, refused: 0, left: 2, signedOut: false });
    expect(ownOutbox(B)).toBe(2);
    expect(queued()).toEqual([]);
    expect(await drain(doFetch as unknown as typeof fetch)).toEqual({ sent: 0, refused: 0, left: 0, signedOut: false });
    expect(doFetch).not.toHaveBeenCalled();
  });

  it("wait for the same account through a sign-out the session forced, and send once it is back", async () => {
    enqueue({ url: "/kept", method: "POST", body: "{}" });
    expect(await drain(answer(401, { error: "sign in first" }) as unknown as typeof fetch)).toMatchObject({ left: 1, signedOut: true });
    ownOutbox(null);
    expect(ownOutbox(A)).toBe(0);
    expect(await drain(answer(201) as unknown as typeof fetch)).toEqual({ sent: 1, refused: 0, left: 0, signedOut: false });
  });

  it("from before rows carried an account are discarded rather than guessed at", () => {
    localStorage.setItem("vemi:outbox:v1", JSON.stringify([{ id: "x", url: "/old", method: "POST", body: "{}", at: "2026-01-01T00:00:00.000Z" }]));
    expect(ownOutbox(A)).toBe(1);
    expect(queued()).toEqual([]);
  });

  it("are all gone after clearOutbox, and the count says so", () => {
    const counts: number[] = [];
    const stop = onWaiting((n) => counts.push(n));
    enqueue({ url: "/one", method: "POST", body: "{}" });
    clearOutbox();
    stop();
    expect(queued()).toEqual([]);
    expect(localStorage.getItem("vemi:outbox:v1")).toBeNull();
    expect(counts).toEqual([1, 0]);
  });
});
