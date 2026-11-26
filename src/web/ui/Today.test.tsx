import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { TodayTask } from "@vemi/shared";
import type { Coming } from "../comingUp.js";
import type { TodayView } from "../todayView.js";
import { TodayScreen, type TodayScreenProps } from "./Today.js";

const task = (id: string, over: Partial<TodayTask> = {}): TodayTask =>
  ({ id, title: `Task ${id}`, picked: true, overdue: false, dueOn: null, repeat: null, remindAt: null, blocker: null, stateKind: "not_started", todayPosition: null, ...over }) as TodayTask;

const view = (over: Partial<TodayView>): TodayView => ({ done: 0, total: 0, next: null, also: [], finished: [], coming: [], ...over });

const props = (v: TodayView, over: Partial<TodayScreenProps> = {}): TodayScreenProps => ({
  view: v, on: "2026-11-17", whereOf: () => "Shed", draft: "", chips: [], onRestore: () => undefined, popped: null, foldOpen: false, burst: false, onPull: () => undefined,
  onDraft: () => undefined, onAdd: () => undefined, onCompose: () => undefined, onTick: () => undefined,
  onLater: () => undefined, onOpen: () => undefined, onOptions: () => undefined, onFold: () => undefined, ...over,
});

const html = (p: TodayScreenProps): string => renderToStaticMarkup(<TodayScreen {...p} />);

describe("TodayScreen smart chips", () => {
  it("shows a chip for each phrase read from the add box", () => {
    const out = html(props(view({}), { draft: "call vet tomorrow", chips: [{ words: "tomorrow", kind: "date" }] }));
    expect(out).toContain("read from the title");
    expect(out).toContain("tomorrow");
  });

  it("shows no chips when nothing was read", () => {
    expect(html(props(view({})))).not.toContain("read from the title");
  });
});

describe("TodayScreen", () => {
  it("shows only the Add box when nothing is picked or overdue", () => {
    const out = html(props(view({})));
    expect(out).toContain("Add to today");
    expect(out).not.toContain("Next up");
    expect(out).not.toContain("Also today");
    expect(out).not.toContain("of 0 done");
  });

  it("shows progress, Next up and Also today when there is a day", () => {
    const next = task("a", { overdue: true, dueOn: "2026-11-14" });
    const out = html(props(view({
      done: 1, total: 3, next, also: [task("b", { repeat: "day", remindAt: "2026-11-17T09:00" })], finished: [task("c", { stateKind: "finished" })],
    })));
    expect(out).toContain("of 3 done");
    expect(out).toContain("Next up");
    expect(out).toContain("Task a");
    expect(out).toContain("Done");
    expect(out).toContain("Later today");
    expect(out).toContain("Also today");
    expect(out).toContain("Every day");
    expect(out).toContain("9:00 am");
    expect(out).toContain("Overdue");
    expect(out).toContain("Show 1 done");
    expect(out).not.toContain("Task c");
    expect(out).toContain("options for Task b");
  });

  it("opens the done fold", () => {
    const v = view({ done: 1, total: 2, next: task("a"), finished: [task("c", { stateKind: "finished" })] });
    const out = html(props(v, { foldOpen: true }));
    expect(out).toContain("Hide 1 done");
    expect(out).toContain("Task c");
    expect(out).toContain("isdone");
  });

  it("pops the box of the task just finished", () => {
    const v = view({ done: 1, total: 2, next: task("a"), finished: [task("c", { stateKind: "finished" })] });
    expect(html(props(v, { foldOpen: true, popped: "c" }))).toContain("trow isdone pop");
  });

  it("honours reduced motion", () => {
    const css = readFileSync(new URL("./today.css", import.meta.url), "utf8");
    expect(css).toMatch(/prefers-reduced-motion: reduce[\s\S]*animation: none/);
  });

  const soon = (id: string, date: string): Coming => ({ id, kind: "task", date, ventureId: "v", title: `Soon ${id}`, overdue: false });

  it("lists Coming up with Do today, and hides it when empty", () => {
    const v = view({ done: 0, total: 1, next: task("a"), coming: [soon("x", "2026-11-18"), soon("y", "2026-11-20")] });
    const out = html(props(v));
    expect(out).toContain("Coming up");
    expect(out).toContain("Soon x");
    expect(out).toContain("Soon y");
    expect(out.match(/Do today/g)?.length).toBe(2);
    expect(html(props(view({ done: 0, total: 1, next: task("a") })))).not.toContain("Coming up");
  });

  it("shows Coming up even when nothing is picked", () => {
    expect(html(props(view({ coming: [soon("x", "2026-11-18")] })))).toContain("Coming up");
  });

  it("shows Day cleared with the count and a pull-forward line only when Coming up is not empty", () => {
    const fin = [task("c", { stateKind: "finished" }), task("d", { stateKind: "finished" })];
    const empty = html(props(view({ done: 2, total: 2, finished: fin })));
    expect(empty).toContain("Day cleared");
    expect(empty).toContain("2 done");
    expect(empty).not.toContain("Pull something forward or call it.");
    expect(empty).not.toContain("Next up");
    const withSoon = html(props(view({ done: 2, total: 2, finished: fin, coming: [soon("x", "2026-11-18")] })));
    expect(withSoon).toContain("Pull something forward or call it.");
  });

  it("does not show Day cleared while a task is open", () => {
    const out = html(props(view({ done: 1, total: 2, next: task("a"), finished: [task("c", { stateKind: "finished" })] })));
    expect(out).not.toContain("Day cleared");
  });

  it("draws the burst only on the tick that cleared the day", () => {
    const v = view({ done: 1, total: 1, finished: [task("c", { stateKind: "finished" })] });
    expect(html(props(v))).not.toContain("clear-burst");
    expect(html(props(v, { burst: true }))).toContain("clear-burst");
  });

  it("honours reduced motion for the burst and the ring", () => {
    const css = readFileSync(new URL("./today.css", import.meta.url), "utf8");
    expect(css).toMatch(/prefers-reduced-motion: reduce[\s\S]*\.clear-burst b \{ animation: none/);
    expect(css).toMatch(/prefers-reduced-motion: reduce[\s\S]*\.clear-ring \.ring-arc \{ transition: none/);
  });
});

describe("TodayScreen home chip", () => {
  it("shows the space the add box files into as a chip", () => {
    const out = html(props(view({}), { home: "Shed", onHome: () => undefined }));
    expect(out).toContain("New tasks go to Shed");
  });

  it("shows no chip when there is no space", () => {
    expect(html(props(view({}), { home: null, onHome: () => undefined }))).not.toContain("New tasks go to");
    expect(html(props(view({})))).not.toContain("New tasks go to");
  });
});
