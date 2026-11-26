import { afterEach, describe, expect, it, vi } from "vitest";
import { appStarted, fetchOrEarly, takeEarly } from "./earlyAnswers.js";

type Fake = { vemiEarly?: Record<string, { at: number; answer: Promise<Response> }>; vemiStarted?: boolean };

function holdOn(entries: Record<string, { at: number; answer: Promise<Response> }>): Fake {
  const fake: Fake = { vemiEarly: entries };
  vi.stubGlobal("window", fake);
  return fake;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("the answers early.js held", () => {
  it("hands each over once", () => {
    const answer = Promise.resolve(new Response("{}"));
    holdOn({ "/api/tree": { at: Date.now(), answer } });
    expect(takeEarly("/api/tree")).toBe(answer);
    expect(takeEarly("/api/tree")).toBeNull();
  });

  it("holds an answer for fifteen seconds and no longer", () => {
    vi.useFakeTimers();
    vi.setSystemTime(100_000);
    const answer = Promise.resolve(new Response("{}"));
    holdOn({ "/a": { at: 100_000 - 15_000, answer }, "/b": { at: 100_000 - 15_001, answer } });
    expect(takeEarly("/a")).toBe(answer);
    expect(takeEarly("/b")).toBeNull();
  });

  it("is empty without the script or a window", () => {
    expect(takeEarly("/api/tree")).toBeNull();
    vi.stubGlobal("window", {});
    expect(takeEarly("/api/tree")).toBeNull();
  });

  it("asks the Worker when the held answer failed", async () => {
    const rejected = Promise.reject(new Error("offline"));
    rejected.catch(() => {});
    holdOn({ "/api/tree": { at: Date.now(), answer: rejected } });
    const fetched = vi.fn(async () => new Response("fresh"));
    vi.stubGlobal("fetch", fetched);
    const response = await fetchOrEarly("/api/tree");
    expect(await response.text()).toBe("fresh");
    expect(fetched).toHaveBeenCalledTimes(1);
  });

  it("uses the held answer without asking the Worker, then asks it for the next read", async () => {
    holdOn({ "/api/tree": { at: Date.now(), answer: Promise.resolve(new Response("held")) } });
    const fetched = vi.fn(async () => new Response("fresh"));
    vi.stubGlobal("fetch", fetched);
    expect(await (await fetchOrEarly("/api/tree")).text()).toBe("held");
    expect(fetched).not.toHaveBeenCalled();
    expect(await (await fetchOrEarly("/api/tree")).text()).toBe("fresh");
  });

  it("tells the script the app has started", () => {
    const fake = holdOn({});
    appStarted();
    expect(fake.vemiStarted).toBe(true);
  });
});
