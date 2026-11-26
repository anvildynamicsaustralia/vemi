import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ReviewTask } from "@vemi/shared";
import { levelWords } from "../levelWords.js";
import { clearFields, ReviewScreen, type ReviewScreenProps } from "./Review.js";

const task = (id: string, over: Partial<ReviewTask> = {}): ReviewTask =>
  ({ id, title: `Task ${id}`, dueOn: null, updatedAt: "2026-11-10T00:00:00.000Z", archivedAt: null, finished: false, ...over }) as ReviewTask;

const props = (over: Partial<ReviewScreenProps> = {}): ReviewScreenProps => ({
  step: 0, on: "2026-11-17", review: { lookBack: [], clearUp: [], lookAhead: [] }, whereOf: () => "Shed",
  words: levelWords(), doneOn: null, repeated: false,
  onStep: () => undefined, onClear: () => undefined, onFinish: () => undefined, onRepeat: () => undefined, ...over,
});

const html = (p: ReviewScreenProps): string => renderToStaticMarkup(<ReviewScreen {...p} />);

describe("clearFields", () => {
  it("Today picks the task for today and makes it due today", () => {
    expect(clearFields("today", "2026-11-17")).toEqual({ pickedOn: "2026-11-17", dueOn: "2026-11-17" });
  });
  it("Tomorrow and Next week move the due date", () => {
    expect(clearFields("tomorrow", "2026-11-17")).toEqual({ dueOn: "2026-11-18" });
    expect(clearFields("week", "2026-11-17")).toEqual({ dueOn: "2026-11-24" });
  });
});

describe("ReviewScreen", () => {
  it("step one lists what was finished, with the place of each", () => {
    const out = html(props({ review: { lookBack: [task("a", { finished: true })], clearUp: [], lookAhead: [] } }));
    expect(out).toContain("Look back");
    expect(out).toContain("Task a");
    expect(out).toContain("Shed");
  });

  it("step two offers Today, Tomorrow, Next week and Archive on each task", () => {
    const out = html(props({ step: 1, review: { lookBack: [], clearUp: [task("b", { dueOn: "2026-11-10" })], lookAhead: [] } }));
    expect(out).toContain("Clear up");
    for (const word of ["Today", "Tomorrow", "Next week", "Archive"]) expect(out).toContain(`>${word}<`);
  });

  it("step two with nothing to clear says so in one short line", () => {
    const out = html(props({ step: 1 }));
    expect(out).toContain("Nothing to clear up.");
    expect(out).not.toContain(">Archive<");
  });

  it("step three lists what is due in the next 7 days and ends with Review done", () => {
    const out = html(props({ step: 2, review: { lookBack: [], clearUp: [], lookAhead: [task("c", { dueOn: "2026-11-19" })] } }));
    expect(out).toContain("Look ahead");
    expect(out).toContain("Task c");
    expect(out).toContain(">Review done<");
  });

  it("has no undo or redo button and no help button", () => {
    for (const step of [0, 1, 2, 3] as const) {
      const out = html(props({ step, doneOn: "2026-11-17", review: { lookBack: [], clearUp: [task("b")], lookAhead: [] } })).toLowerCase();
      expect(out).not.toContain("undo");
      expect(out).not.toContain("redo");
      expect(out).not.toContain("help");
    }
  });

  it("after the review shows the date and a Repeat every week button, once", () => {
    const out = html(props({ step: 3, doneOn: "2026-11-17" }));
    expect(out).toContain("Review done");
    expect(out).toContain("tue 17 nov");
    expect(out).toContain(">Repeat every week<");
    expect(html(props({ step: 3, doneOn: "2026-11-17", repeated: true }))).not.toContain(">Repeat every week<");
  });

  it("reads in the person's level words", () => {
    const out = html(props({ words: levelWords({ task: "Job" }) }));
    expect(out).toContain("No jobs finished");
  });
});
