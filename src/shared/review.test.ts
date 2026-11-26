import { describe, expect, it } from "vitest";
import { reviewOf, type ReviewTask } from "./review.js";

const TODAY = "2026-11-17";

function task(id: string, over: Partial<ReviewTask> = {}): ReviewTask {
  return {
    id,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-11-17T01:00:00.000Z",
    archivedAt: null,
    ventureId: "v1",
    projectId: null,
    milestoneId: null,
    stateId: null,
    title: id,
    body: null,
    checklist: [],
    priority: null,
    dueOn: null,
    pickedOn: null,
    position: 0,
    todayPosition: null,
    remindAt: null,
    repeat: null,
    finished: false,
    ...over,
  } as ReviewTask;
}

const ids = (list: readonly { id: string }[]): string[] => list.map((t) => t.id);

describe("lookBack", () => {
  it("holds finished tasks touched in the last 7 days, newest first", () => {
    const r = reviewOf(
      [
        task("old", { finished: true, updatedAt: "2026-11-12T09:00:00.000Z" }),
        task("new", { finished: true, updatedAt: "2026-11-17T09:00:00.000Z" }),
        task("mid", { finished: true, updatedAt: "2026-11-15T09:00:00.000Z" }),
      ],
      TODAY,
    );
    expect(ids(r.lookBack)).toEqual(["new", "mid", "old"]);
  });

  it("includes 6 days ago and leaves out 7 days ago", () => {
    const r = reviewOf(
      [
        task("six", { finished: true, updatedAt: "2026-11-11T00:00:00.000Z" }),
        task("seven", { finished: true, updatedAt: "2026-11-10T23:59:59.000Z" }),
      ],
      TODAY,
    );
    expect(ids(r.lookBack)).toEqual(["six"]);
  });

  it("ignores unfinished tasks", () => {
    expect(reviewOf([task("a")], TODAY).lookBack).toEqual([]);
  });
});

describe("clearUp", () => {
  it("lists tasks due before today by date, then tasks untouched for 30 days", () => {
    const r = reviewOf(
      [
        task("untouched", { updatedAt: "2026-10-01T00:00:00.000Z" }),
        task("late2", { dueOn: "2026-11-16" }),
        task("late1", { dueOn: "2026-11-01" }),
      ],
      TODAY,
    );
    expect(ids(r.clearUp)).toEqual(["late1", "late2", "untouched"]);
  });

  it("takes a task at 30 days and not at 29", () => {
    const r = reviewOf(
      [
        task("thirty", { updatedAt: "2026-10-18T12:00:00.000Z" }),
        task("twentynine", { updatedAt: "2026-10-19T00:00:00.000Z" }),
      ],
      TODAY,
    );
    expect(ids(r.clearUp)).toEqual(["thirty"]);
  });

  it("does not treat a task due today as past due", () => {
    expect(reviewOf([task("a", { dueOn: TODAY })], TODAY).clearUp).toEqual([]);
  });

  it("lists a task that is due before today and untouched once", () => {
    const r = reviewOf([task("both", { dueOn: "2026-11-01", updatedAt: "2026-09-01T00:00:00.000Z" })], TODAY);
    expect(ids(r.clearUp)).toEqual(["both"]);
  });

  it("leaves out finished tasks", () => {
    const r = reviewOf([task("done", { finished: true, dueOn: "2026-11-01", updatedAt: "2026-09-01T00:00:00.000Z" })], TODAY);
    expect(r.clearUp).toEqual([]);
  });
});

describe("lookAhead", () => {
  it("holds unfinished tasks due in the next 7 days, by date", () => {
    const r = reviewOf(
      [
        task("b", { dueOn: "2026-11-20" }),
        task("a", { dueOn: TODAY }),
        task("c", { dueOn: "2026-11-23" }),
        task("past", { dueOn: "2026-11-16" }),
        task("far", { dueOn: "2026-11-24" }),
        task("none"),
        task("done", { dueOn: "2026-11-18", finished: true }),
      ],
      TODAY,
    );
    expect(ids(r.lookAhead)).toEqual(["a", "b", "c"]);
  });
});

describe("archived", () => {
  it("never appears in any group", () => {
    const archivedAt = "2026-11-16T00:00:00.000Z";
    const r = reviewOf(
      [
        task("a", { archivedAt, finished: true }),
        task("b", { archivedAt, dueOn: "2026-11-01" }),
        task("c", { archivedAt, updatedAt: "2026-09-01T00:00:00.000Z" }),
        task("d", { archivedAt, dueOn: "2026-11-18" }),
      ],
      TODAY,
    );
    expect(r).toEqual({ lookBack: [], clearUp: [], lookAhead: [] });
  });
});
