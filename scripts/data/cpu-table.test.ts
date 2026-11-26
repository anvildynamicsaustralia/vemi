import { describe, expect, it } from "vitest";
import { collapseIds, parseEvents, render, summarise } from "./cpu-table.mjs";

// The event is the documented `wrangler tail` object (outcome, scriptName, exceptions,
// logs, eventTimestamp, event.request{url,method,headers,cf}) plus the CPU field.
function ev(method: string, path: string, cpuTime?: number, ts = 1590680082349) {
  return {
    outcome: "ok",
    scriptName: "vemi",
    exceptions: [],
    logs: [],
    eventTimestamp: ts,
    event: { request: { url: `https://example.test${path}`, method, headers: {}, cf: {} } },
    ...(cpuTime === undefined ? {} : { cpuTime }),
  };
}

describe("cpu-table", () => {
  it("collapses ids", () => {
    const id = ["3f2a9c1e", "1111", "4222", "8333", "444455556666"].join("-");
    expect(collapseIds(`/api/tasks/${id}`)).toBe("/api/tasks/:id");
    expect(collapseIds("/api/ventures/12/tasks")).toBe("/api/ventures/:id/tasks");
    expect(collapseIds("/api/search")).toBe("/api/search");
  });
  it("gives median, worst, count and date", () => {
    const s = summarise([ev("GET", "/api/map", 2), ev("GET", "/api/map", 4), ev("GET", "/api/map", 9)]);
    expect(s.rows).toEqual([{ route: "GET /api/map", typical: 4, worst: 9, count: 3, noCpu: 0, date: "2020-05-28" }]);
    expect(s.flagged).toEqual([]);
  });
  it("merges routes that differ only by id", () => {
    const s = summarise([ev("GET", "/api/tasks/101", 1), ev("GET", "/api/tasks/202", 3)]);
    expect(s.rows).toHaveLength(1);
    expect(s.rows[0].route).toBe("GET /api/tasks/:id");
    expect(s.rows[0].typical).toBe(2);
  });
  it("flags a route whose worst is over 10", () => {
    const s = summarise([ev("POST", "/api/restore", 3), ev("POST", "/api/restore", 11)]);
    expect(s.flagged).toEqual(["POST /api/restore"]);
    expect(render(s)).toContain("OVER 10");
  });
  it("reports an event with no CPU field and never counts it as 0", () => {
    const s = summarise([ev("GET", "/api/map", 6), ev("GET", "/api/map")]);
    expect(s.rows[0].typical).toBe(6);
    expect(s.rows[0].noCpu).toBe(1);
    expect(s.rows[0].count).toBe(2);
    const only = summarise([ev("GET", "/api/today")]);
    expect(only.rows[0].typical).toBeNull();
    expect(render(only)).toContain("no CPU field");
  });
  it("reads lines and arrays", () => {
    const a = ev("GET", "/a", 1);
    expect(parseEvents(`${JSON.stringify(a)}\n${JSON.stringify(a)}\n`)).toHaveLength(2);
    expect(parseEvents(JSON.stringify([a, a, a]))).toHaveLength(3);
    expect(parseEvents("")).toEqual([]);
  });
});
