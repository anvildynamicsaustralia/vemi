import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const SCRIPT = readFileSync(new URL("../../public/early.js", import.meta.url), "utf8");

interface Win {
  vemiEarly?: Record<string, unknown>;
  vemiStarted?: boolean;
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 30));

/** Runs the script text against a fake page whose Worker answers /auth/me as given. */
async function run(options: { signedIn: boolean; marker?: boolean }): Promise<{ asked: string[]; win: Win }> {
  const asked: string[] = [];
  const win: Win = {};
  const fetched = async (path: string): Promise<Response> => {
    asked.push(path);
    return path === "/auth/me"
      ? new Response(JSON.stringify({ signedIn: options.signedIn }), { status: 200 })
      : new Response("{}", { status: options.signedIn ? 200 : 401 });
  };
  const storage = { getItem: (key: string) => (options.marker === true && key === "vemi:signed-in:v1" ? "a@b.c" : null) };
  new Function("window", "fetch", "localStorage", SCRIPT)(win, fetched, storage);
  await settle();
  return { asked, win };
}

describe("early.js", () => {
  it("costs a signed-out visit one request", async () => {
    const { asked, win } = await run({ signedIn: false });
    expect(asked).toEqual(["/auth/me"]);
    expect(Object.keys(win.vemiEarly ?? {})).toEqual(["/auth/me"]);
  });

  it("asks for the rest once the sign-in is confirmed", async () => {
    const { asked } = await run({ signedIn: true });
    expect(asked[0]).toBe("/auth/me");
    expect(asked).toEqual(expect.arrayContaining(["/api/tree", "/api/overview", "/api/appearance", "/api/first-run"]));
    expect(asked.some((path) => path.startsWith("/api/today?tz="))).toBe(true);
  });

  it("asks for everything at once when this device remembers a sign-in, and drops it if refused", async () => {
    const { asked, win } = await run({ signedIn: false, marker: true });
    expect(asked.length).toBe(6);
    expect(Object.keys(win.vemiEarly ?? {})).toEqual(["/auth/me"]);
  });

  it("does nothing once the app's main module has started", async () => {
    const asked: string[] = [];
    const win: Win = { vemiStarted: true };
    new Function("window", "fetch", "localStorage", SCRIPT)(win, async (path: string) => asked.push(path), { getItem: () => null });
    await settle();
    expect(asked).toEqual([]);
    expect(win.vemiEarly).toBeUndefined();
  });
});
