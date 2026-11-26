import { describe, expect, it } from "vitest";
import { jobs, tick, type Job } from "./tick.js";

const env = { DB: undefined as never };
const at = (iso: string): Date => new Date(iso);

function counting(schedule: string): { job: Job; runs: Date[] } {
  const runs: Date[] = [];
  return { job: { name: schedule, schedule, run: (now) => void runs.push(now) }, runs };
}

describe("tick", () => {
  it("runs an every-minute job at any time", async () => {
    const { job, runs } = counting("* * * * *");
    await tick(at("2026-11-15T00:00:00Z"), env, [job]);
    await tick(at("2026-11-15T13:37:59Z"), env, [job]);
    expect(runs).toHaveLength(2);
  });

  it("runs a daily 03:00 UTC job only at 03:00", async () => {
    const { job, runs } = counting("0 3 * * *");
    await tick(at("2026-11-15T03:00:10Z"), env, [job]);
    await tick(at("2026-11-15T03:01:00Z"), env, [job]);
    await tick(at("2026-11-15T04:00:00Z"), env, [job]);
    await tick(at("2026-11-15T15:00:00Z"), env, [job]);
    expect(runs).toHaveLength(1);
  });

  it("keeps running the other jobs when one throws, and logs it", async () => {
    const logged: unknown[][] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => void logged.push(args);
    try {
      const after = counting("* * * * *");
      const broken: Job = {
        name: "broken",
        schedule: "* * * * *",
        run: () => {
          throw new Error("boom");
        },
      };
      const rejecting: Job = {
        name: "rejecting",
        schedule: "* * * * *",
        run: () => Promise.reject(new Error("later")),
      };
      await tick(at("2026-11-15T03:00:00Z"), env, [broken, rejecting, after.job]);
      expect(after.runs).toHaveLength(1);
      expect(logged.map((l) => String(l[0]))).toEqual([
        expect.stringContaining("broken"),
        expect.stringContaining("rejecting"),
      ]);
    } finally {
      console.error = original;
    }
  });

  it("has the update check registered once, on the shared cron, with no second trigger", () => {
    const named = jobs.filter((j) => j.name === "update-check");
    expect(named).toHaveLength(1);
    expect(named[0]!.schedule).toBe("11 * * * *");
  });

  it("does nothing today, as no job is registered", async () => {
    await expect(tick(at("2026-11-15T03:00:00Z"), env)).resolves.toBeUndefined();
  });
});
