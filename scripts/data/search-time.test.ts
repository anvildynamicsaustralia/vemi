import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { execFileSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseBase, stats, timeSearches } from "./search-time.mjs";

let server: Server;
let base: string;
const seen: { url?: string; cookie?: string }[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    seen.push({ url: req.url, cookie: req.headers.cookie });
    if (req.headers.cookie !== "sid=fake") {
      res.statusCode = 401;
      res.end("no");
      return;
    }
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ results: [] }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

describe("search-time", () => {
  it("times 20 searches against a local fake server", async () => {
    const r = await timeSearches({ base, cookie: "sid=fake", query: "a b" });
    expect(r.times).toHaveLength(20);
    expect(r.worst).toBeGreaterThanOrEqual(r.median);
    expect(seen.at(-1)?.url).toBe("/api/search?q=a%20b");
  });
  it("stops on a refused session", async () => {
    await expect(timeSearches({ base, cookie: "sid=wrong", runs: 1 })).rejects.toThrow(/401/);
  });
  it("computes median and worst", () => {
    expect(stats([5, 1, 3])).toEqual({ median: 3, worst: 5 });
    expect(stats([1, 2, 3, 10])).toEqual({ median: 2.5, worst: 10 });
  });
  it("refuses a missing or bad base URL and never defaults", () => {
    expect(() => parseBase(undefined)).toThrow(/required/);
    expect(() => parseBase("nonsense")).toThrow(/Not a URL/);
    expect(() => parseBase("ftp://x.test")).toThrow(/http/);
    expect(parseBase("http://localhost:8787/x")).toBe("http://localhost:8787");
    let code = 0;
    try {
      execFileSync(process.execPath, ["scripts/data/search-time.mjs"], { stdio: "pipe" });
    } catch (e) {
      code = (e as { status: number }).status;
    }
    expect(code).toBe(2);
  });
});
