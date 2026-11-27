import { describe, expect, it } from "vitest";
import type { Plate } from "../plates.js";
import { autoLayout, boxKey, dragged, gesture, resolve, SIZE, stepZoom, wires, ZOOM_MAX, ZOOM_MIN } from "./canvasLayout.js";

const project = (id: string, ventureId: string) => ({
  id, ventureId, name: id, pinned: false, flag: null, stage: null, left: 0, done: 0, onToday: false,
});
const plate = (id: string, projects: string[] = [], inner: Plate[] = []): Plate => ({
  id, name: id, icon: null, letters: id.toUpperCase(), stage: null, flags: [], counts: { left: 0, done: 0 },
  projects: projects.map((p) => project(p, id)), inner,
});
const at = (boxes: ReturnType<typeof autoLayout>, key: string) => boxes.find((b) => b.key === key)!;

describe("the canvas auto layout", () => {
  it("puts top-level spaces in columns, left to right, on one row", () => {
    const boxes = autoLayout([plate("a", ["a1"]), plate("b"), plate("c")]);
    const [a, b, c] = ["a", "b", "c"].map((id) => at(boxes, boxKey("venture", id)));
    expect(a!.y).toBe(b!.y);
    expect(b!.y).toBe(c!.y);
    expect(b!.x).toBeGreaterThan(a!.x + SIZE.venture.w);
    expect(c!.x).toBeGreaterThan(b!.x + SIZE.venture.w);
  });

  it("stacks a space's projects under it, in order, indented", () => {
    const boxes = autoLayout([plate("a", ["p1", "p2", "p3"])]);
    const s = at(boxes, "venture:a");
    const ys = ["p1", "p2", "p3"].map((p) => at(boxes, boxKey("project", p)));
    expect(ys[0]!.y).toBeGreaterThanOrEqual(s.y + SIZE.venture.h);
    expect(ys[1]!.y).toBeGreaterThanOrEqual(ys[0]!.y + SIZE.project.h);
    expect(ys[2]!.y).toBeGreaterThanOrEqual(ys[1]!.y + SIZE.project.h);
    expect(ys.every((p) => p.x > s.x && p.parent === "venture:a")).toBe(true);
  });

  it("puts a nested space under its parent's projects, joined to the parent", () => {
    const boxes = autoLayout([plate("a", ["p1", "p2"], [plate("in", ["q1"])])]);
    const inner = at(boxes, "venture:in");
    const last = at(boxes, "project:p2");
    expect(inner.parent).toBe("venture:a");
    expect(inner.y).toBeGreaterThanOrEqual(last.y + SIZE.project.h);
    expect(at(boxes, "project:q1").y).toBeGreaterThanOrEqual(inner.y + SIZE.venture.h);
    expect(at(boxes, "project:q1").parent).toBe("venture:in");
  });

  it("keeps the next column clear of a nested space", () => {
    const boxes = autoLayout([plate("a", [], [plate("in", ["q"])]), plate("b")]);
    const right = Math.max(...boxes.filter((b) => b.key !== "venture:b").map((b) => b.x + SIZE[b.kind].w));
    expect(at(boxes, "venture:b").x).toBeGreaterThan(right);
  });

  it("is the same every time", () => {
    const plates = [plate("a", ["p"]), plate("b")];
    expect(autoLayout(plates)).toEqual(autoLayout(plates));
  });
});

describe("saved positions", () => {
  const plates = [plate("a", ["p"])];
  it("win over the layout, for the box they name", () => {
    const boxes = resolve(plates, [{ kind: "project", id: "p", x: 500, y: 300 }]);
    expect(at(boxes, "project:p")).toMatchObject({ x: 500, y: 300 });
    expect(at(boxes, "venture:a")).toEqual(at(autoLayout(plates), "venture:a"));
  });
  it("name a venture and a project with the same id apart", () => {
    const boxes = resolve([plate("x", ["x"])], [{ kind: "venture", id: "x", x: 9, y: 9 }]);
    expect(at(boxes, "venture:x")).toMatchObject({ x: 9, y: 9 });
    expect(at(boxes, "project:x").x).not.toBe(9);
  });
  it("are ignored for a box that is gone, and never go negative", () => {
    const boxes = resolve(plates, [{ kind: "venture", id: "gone", x: 1, y: 1 }, { kind: "venture", id: "a", x: -50, y: -5 }]);
    expect(boxes).toHaveLength(2);
    expect(at(boxes, "venture:a")).toMatchObject({ x: 0, y: 0 });
  });
});

describe("wires", () => {
  it("join every box to the one it hangs from and none to a top-level space", () => {
    const boxes = autoLayout([plate("a", ["p"], [plate("in")])]);
    expect(wires(boxes).map((w) => w.key).sort()).toEqual(["project:p", "venture:in"]);
  });
});

describe("zoom", () => {
  it("steps by tenths without drift and stops at 50 and 150", () => {
    let z = 1;
    for (let i = 0; i < 3; i++) z = stepZoom(z, 1);
    expect(z).toBe(1.3);
    for (let i = 0; i < 20; i++) z = stepZoom(z, 1);
    expect(z).toBe(ZOOM_MAX);
    for (let i = 0; i < 30; i++) z = stepZoom(z, -1);
    expect(z).toBe(ZOOM_MIN);
  });
});

describe("click or drag", () => {
  it("is a click under 4 pixels of travel and a drag from 4", () => {
    expect(gesture(0, 0)).toBe("click");
    expect(gesture(2, 2)).toBe("click");
    expect(gesture(4, 0)).toBe("drag");
    expect(gesture(-3, 3)).toBe("drag");
  });
  it("moves a box by the travel in ground units, never off the top or left", () => {
    expect(dragged({ x: 100, y: 100 }, 50, -20, 0.5)).toEqual({ x: 200, y: 60 });
    expect(dragged({ x: 10, y: 10 }, -100, -100, 1)).toEqual({ x: 0, y: 0 });
  });
});

describe("fitZoom", () => {
  it("fits a wide ground into a phone's width in 10% steps", async () => {
    const { fitZoom } = await import("./canvasLayout.js");
    expect(fitZoom(1000, 350)).toBe(0.5);
    expect(fitZoom(600, 350)).toBe(0.5);
    expect(fitZoom(500, 350)).toBe(0.7);
  });
  it("never zooms past 100% and treats an unknown size as 100%", async () => {
    const { fitZoom } = await import("./canvasLayout.js");
    expect(fitZoom(200, 350)).toBe(1);
    expect(fitZoom(0, 350)).toBe(1);
  });
});

describe("the stacked layout", () => {
  it("puts top-level spaces one under another, and its ground is only as wide as they are", async () => {
    const { autoLayout, groundSize } = await import("./canvasLayout.js");
    const plate = (id: string) => ({ id, name: id, letters: "X", icon: null, stage: null, flags: [], counts: { left: 0, done: 0, total: 0 }, projects: [], inner: [] }) as unknown as Plate;
    const boxes = autoLayout([plate("a"), plate("b")], "stacked");
    expect(boxes.map((b) => b.x)).toEqual([16, 16]);
    expect(boxes[1]!.y).toBeGreaterThan(boxes[0]!.y);
    expect(groundSize(boxes, "stacked").w).toBeLessThan(350);
    expect(groundSize(autoLayout([plate("a"), plate("b")])).w).toBe(1320);
  });
});
