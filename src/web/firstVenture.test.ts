import { describe, expect, it } from "vitest";
import type { Overview, OverviewVenture, Today, Tree, TreeVenture } from "@vemi/shared";
import { isFirstRun, opened, cardOutcome, firstRunProgress } from "./firstVenture.js";

const overview = (ventures: number, archivedVentures: number): Overview => ({
  ventures: Array.from({ length: ventures }, (_, i) => ({ id: `v${i}` }) as OverviewVenture),
  archivedVentures,
});

const tree = (...ids: string[]): Tree => ({
  ventures: ids.map((id) => ({ id }) as TreeVenture),
});

describe("isFirstRun", () => {
  it("is true with no ventures and none archived", () => {
    expect(isFirstRun(overview(0, 0))).toBe(true);
  });

  it("is false with a live venture", () => {
    expect(isFirstRun(overview(1, 0))).toBe(false);
  });

  it("is false with only archived ventures", () => {
    expect(isFirstRun(overview(0, 2))).toBe(false);
  });

  it("is false with both live and archived ventures", () => {
    expect(isFirstRun(overview(3, 1))).toBe(false);
  });

  it("is undecided until the overview has loaded", () => {
    expect(isFirstRun(null)).toBeNull();
  });
});

describe("opened", () => {
  it("is false while the tree has not loaded", () => {
    expect(opened(null, "v0")).toBe(false);
  });

  it("is false while the tree lacks that venture", () => {
    expect(opened(tree("other"), "v0")).toBe(false);
  });

  it("is true once the tree holds that venture", () => {
    expect(opened(tree("other", "v0"), "v0")).toBe(true);
  });
});

describe("cardOutcome", () => {
  it("opens the venture this card asked for once the tree holds it", () => {
    expect(cardOutcome(tree("mine"), overview(1, 0), "mine")).toBe("open");
  });

  it("opens this card's venture even when another arrived beside it", () => {
    expect(cardOutcome(tree("other", "mine"), overview(2, 0), "mine")).toBe("open");
  });

  it("leaves when a venture came from somewhere else", () => {
    expect(cardOutcome(tree("other"), overview(1, 0), "mine")).toBe("leave");
  });

  it("leaves when a venture was archived meanwhile", () => {
    expect(cardOutcome(tree(), overview(0, 1), "mine")).toBe("leave");
  });

  it("waits while nothing has arrived, or nothing has loaded", () => {
    expect(cardOutcome(tree(), overview(0, 0), "mine")).toBe("wait");
    expect(cardOutcome(null, null, "mine")).toBe("wait");
  });
});

describe("firstRunProgress", () => {
  const built = (opts: { project?: boolean; task?: boolean; picked?: string | null } = {}): Tree => ({
    ventures: [{
      id: "v1",
      projects: opts.project === false ? [] : [{
        id: "p1",
        tasks: opts.task === false ? [] : [{ id: "t1", pickedOn: opts.picked ?? null }],
      }],
    } as unknown as TreeVenture],
  });
  const today = { on: "2026-11-19", tasks: [] } as unknown as Today;

  it("stays on a step whose thing is not there", () => {
    expect(firstRunProgress(2, tree(), today).step).toBe(2);
    expect(firstRunProgress(3, built({ project: false }), today).step).toBe(3);
    expect(firstRunProgress(4, built({ task: false }), today).step).toBe(4);
    expect(firstRunProgress(5, built(), today).step).toBe(5);
  });

  it("moves on past things that already exist", () => {
    expect(firstRunProgress(2, built(), today)).toEqual({ step: 5, ventureId: "v1", projectId: "p1", taskId: "t1" });
    expect(firstRunProgress(3, built(), today).step).toBe(5);
    expect(firstRunProgress(4, built(), today).step).toBe(5);
    expect(firstRunProgress(5, built({ picked: "2026-11-19" }), today).step).toBe(6);
  });

  it("does not guess at step 5 before today has answered", () => {
    expect(firstRunProgress(5, built({ picked: "2026-11-19" }), null).step).toBe(5);
  });

  it("waits for the tree and leaves other steps alone", () => {
    expect(firstRunProgress(2, null, today).step).toBe(2);
    expect(firstRunProgress(1, built(), today).step).toBe(1);
    expect(firstRunProgress(6, built(), today).step).toBe(6);
  });
});
