import { describe, expect, it } from "vitest";
import { ventureMove } from "./ventureMove.js";

describe("a task moved into another venture", () => {
  const task = { ventureId: "studios", projectId: "slice", milestoneId: "slice-done", stateId: "studios-review" };

  it("sends the venture alone, so the Worker finds the state of the same kind", () => {
    expect(ventureMove(task, "network").forward).toEqual({ ventureId: "network" });
  });

  it("comes back with its venture, project, milestone and state, as they were", () => {
    expect(ventureMove(task, "network").back).toEqual(task);
  });

  it("comes back with nothing it did not have", () => {
    const bare = { ventureId: "studios", projectId: null, milestoneId: null, stateId: null };
    expect(ventureMove(bare, "network").back).toEqual(bare);
  });
});
