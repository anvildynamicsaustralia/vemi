import { describe, expect, it } from "vitest";
import type { StateKind } from "@vemi/shared";
import { tickTask } from "./tickTask.js";

const venture = (kinds: StateKind[]) => ({
  name: "Shed",
  states: kinds.map((kind, i) => ({ id: `s-${kind}`, kind, position: i, createdAt: `2026-11-0${i + 1}` })),
});

function harness(answers: unknown[] = []) {
  const updates: unknown[][] = [];
  const archived: unknown[][] = [];
  const notes: string[] = [];
  const steps: { what: string; undo: () => Promise<unknown>; redo: () => Promise<unknown> }[] = [];
  const send = {
    act: (work: () => Promise<unknown>, step: (typeof steps)[number]) => {
      steps.push(step);
      return work().then(() => true as const);
    },
    update: (kind: "tasks", id: string, fields: { stateId: string | null }) => {
      updates.push([kind, id, fields]);
      return Promise.resolve(answers.shift());
    },
    archive: (kind: "tasks", id: string) => {
      archived.push([kind, id]);
      return Promise.resolve();
    },
    notify: (m: string) => void notes.push(m),
  };
  return { send, updates, archived, notes, steps };
}

const task = { id: "t1", title: "Sand it", stateId: "s-not_started" };

describe("tickTask", () => {
  it("moves an open task to the first finished state, with a step that undoes it", async () => {
    const h = harness();
    const run = tickTask(h.send, task, venture(["not_started", "finished"]), false);
    expect(run).not.toBeNull();
    await run;
    expect(h.updates).toEqual([["tasks", "t1", { stateId: "s-finished" }]]);
    expect(h.steps[0]?.what).toBe("finished Sand it");
    await h.steps[0]?.undo();
    expect(h.updates[1]).toEqual(["tasks", "t1", { stateId: "s-not_started" }]);
    await h.steps[0]?.redo();
    expect(h.updates[2]).toEqual(["tasks", "t1", { stateId: "s-finished" }]);
  });

  it("reopens a finished task into the first not-started state", async () => {
    const h = harness();
    await tickTask(h.send, { ...task, stateId: "s-finished" }, venture(["not_started", "finished"]), true);
    expect(h.updates).toEqual([["tasks", "t1", { stateId: "s-not_started" }]]);
    expect(h.steps[0]?.what).toBe("reopened Sand it");
  });

  it("says so and sends nothing when the space has no state to move into", () => {
    const h = harness();
    expect(tickTask(h.send, task, venture(["not_started"]), false)).toBeNull();
    expect(h.notes).toEqual(["Shed has no finished state to move this into."]);
    expect(tickTask(h.send, task, venture(["finished"]), true)).toBeNull();
    expect(h.notes[1]).toBe("Shed has no not-started state to move this into.");
    expect(h.updates).toEqual([]);
  });

  it("undo reopens the task and archives the one it spawned, and redo repeats both", async () => {
    const h = harness([{ id: "t1", spawned: { id: "n1" } }, undefined, { id: "t1", spawned: { id: "n2" } }, undefined]);
    await tickTask(h.send, task, venture(["not_started", "finished"]), false);
    await h.steps[0]?.undo();
    expect(h.updates[1]).toEqual(["tasks", "t1", { stateId: "s-not_started" }]);
    expect(h.archived).toEqual([["tasks", "n1"]]);
    await h.steps[0]?.redo();
    expect(h.updates[2]).toEqual(["tasks", "t1", { stateId: "s-finished" }]);
    await h.steps[0]?.undo();
    expect(h.archived).toEqual([["tasks", "n1"], ["tasks", "n2"]]);
  });

  it("archives nothing when the answer spawned nothing", async () => {
    const h = harness([{ id: "t1" }]);
    await tickTask(h.send, task, venture(["not_started", "finished"]), false);
    await h.steps[0]?.undo();
    expect(h.archived).toEqual([]);
  });
});
