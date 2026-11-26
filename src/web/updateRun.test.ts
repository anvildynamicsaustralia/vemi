import { describe, expect, it } from "vitest";
import { UpdateCallError, type UpdateApi, type UpdateStep, type UpdateTap } from "./updateApi.js";
import { driveUpdate, keepStep, keptStep, rowsOf, type RunState } from "./updateRun.js";

const tap = (step: UpdateStep, remaining: number, done = false): UpdateTap => ({ step, remaining, done });

/** An api that answers from a script and records each call. */
function scripted(answers: readonly (UpdateTap | UpdateCallError)[]): { api: UpdateApi; calls: string[] } {
  const calls: string[] = [];
  let i = 0;
  const next = async (name: string): Promise<UpdateTap> => {
    calls.push(name);
    const a = answers[i++]!;
    if (a instanceof UpdateCallError) throw a;
    return a;
  };
  return { api: { report: async () => { throw new Error("unused"); }, start: () => next("start"), step: () => next("step") }, calls };
}

const options = (kept: (UpdateStep | null)[], seen: RunState[] = []) => ({
  on: (r: RunState) => { seen.push(r); },
  keep: (s: UpdateStep | null) => { kept.push(s); },
  sleep: async () => undefined,
});

describe("driveUpdate", () => {
  it("starts once, repeats a step while it has work, and stops at done", async () => {
    const { api, calls } = scripted([
      tap("start", 2), tap("files", 1), tap("files", 0), tap("data", 0), tap("app", 0, true),
    ]);
    const kept: (UpdateStep | null)[] = [];
    const end = await driveUpdate(api, "start", options(kept));
    expect(calls).toEqual(["start", "step", "step", "step", "step"]);
    expect(end).toEqual({ at: "app", done: true, error: null });
    expect(kept.at(-1)).toBeNull();
  });

  it("stops at a failure with the Worker's sentence and resumes from that step", async () => {
    const failing = scripted([tap("start", 1), new UpdateCallError(502, "Cloudflare did not answer.", "files")]);
    const kept: (UpdateStep | null)[] = [];
    const stopped = await driveUpdate(failing.api, "start", options(kept));
    expect(stopped).toEqual({ at: "files", done: false, error: "Cloudflare did not answer." });
    expect(kept.at(-1)).toBe("files");

    const again = scripted([tap("files", 0), tap("data", 0), tap("app", 0, true)]);
    const end = await driveUpdate(again.api, "files", options([]));
    expect(again.calls).toEqual(["step", "step", "step"]);
    expect(end.done).toBe(true);
  });

  it("does not call start when it resumes past it", async () => {
    const { api, calls } = scripted([tap("app", 0, true)]);
    await driveUpdate(api, "app", options([]));
    expect(calls).toEqual(["step"]);
  });

  it("waits when the same answer comes twice", async () => {
    const { api } = scripted([tap("files", 2), tap("files", 2), tap("files", 0), tap("data", 0), tap("app", 0, true)]);
    let slept = 0;
    await driveUpdate(api, "files", { ...options([]), sleep: async () => { slept += 1; } });
    expect(slept).toBe(1);
  });
});

describe("rowsOf", () => {
  it("ticks what is behind, works at the step, and waits on the rest", () => {
    expect(rowsOf({ at: "data", done: false, error: null }).map((r) => `${r.label}:${r.state}`)).toEqual([
      "Restore point:done", "App files:done", "Data layout:active", "New version:waiting",
    ]);
  });
  it("marks the failed step and ticks all when done", () => {
    expect(rowsOf({ at: "files", done: false, error: "No." }).map((r) => r.state)).toEqual(["done", "failed", "waiting", "waiting"]);
    expect(rowsOf({ at: "app", done: true, error: null }).every((r) => r.state === "done")).toBe(true);
  });
});

describe("kept step", () => {
  it("remembers the step for one version and forgets it", () => {
    const store = new Map<string, string>();
    const s = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); }, removeItem: (k: string) => { store.delete(k); } };
    keepStep("0.2.0", "data", s);
    expect(keptStep("0.2.0", s)).toBe("data");
    expect(keptStep("0.3.0", s)).toBeNull();
    keepStep("0.2.0", null, s);
    expect(keptStep("0.2.0", s)).toBeNull();
  });
  it("survives a store that throws", () => {
    const bad = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); }, removeItem: () => { throw new Error("blocked"); } };
    expect(() => keepStep("0.2.0", "files", bad)).not.toThrow();
    expect(keptStep("0.2.0", bad)).toBeNull();
  });
});
