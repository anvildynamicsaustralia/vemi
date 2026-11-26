import { afterEach, describe, expect, it, vi } from "vitest";
import { me } from "./auth.js";
import { PATIENCE_MS, withPatience } from "./patience.js";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("withPatience", () => {
  it("gives the answer when it comes in time", async () => {
    await expect(withPatience(Promise.resolve(7), 50)).resolves.toBe(7);
  });

  it("gives up on a promise that never settles", async () => {
    vi.useFakeTimers();
    const outcome = expect(withPatience(new Promise<number>(() => {}), 100)).rejects.toThrow("slow");
    await vi.advanceTimersByTimeAsync(100);
    await outcome;
  });

  it("passes a failure through untouched", async () => {
    await expect(withPatience(Promise.reject(new Error("no")), 50)).rejects.toThrow("no");
  });
});

describe("me() on a weak signal", () => {
  it("rejects after the patience when the request hangs", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => {})));
    const outcome = expect(me()).rejects.toThrow("slow");
    await vi.advanceTimersByTimeAsync(PATIENCE_MS);
    await outcome;
  });

  it("resolves with a prompt answer, untouched", async () => {
    vi.useFakeTimers();
    const body = { signedIn: true, googleReady: false };
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })));
    await expect(me()).resolves.toEqual(body);
  });
});
