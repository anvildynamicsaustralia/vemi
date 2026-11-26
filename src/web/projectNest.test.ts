import { describe, expect, it } from "vitest";
import { homesFor, inOrder, nested, pathOf } from "./projectNest.js";

const AT = "2026-09-01T00:00:00.000Z";
const p = (id: string, position: number, parentId: string | null = null, ventureId = "v1") => ({
  id,
  ventureId,
  name: id.toUpperCase(),
  parentId,
  position,
  createdAt: AT,
});

describe("nested", () => {
  it("puts top-level projects in position order, each with its children in position order", () => {
    const list = [p("c2", 2, "b"), p("b", 2), p("a", 1), p("c1", 1, "b")];
    const out = nested(list);
    expect(out.map((n) => n.project.id)).toEqual(["a", "b"]);
    expect(out[0]?.children).toEqual([]);
    expect(out[1]?.children.map((c) => c.id)).toEqual(["c1", "c2"]);
  });

  it("treats a child whose parent is not in the list as top-level", () => {
    const out = nested([p("a", 1), p("orphan", 2, "gone")]);
    expect(out.map((n) => n.project.id)).toEqual(["a", "orphan"]);
  });
});

describe("inOrder", () => {
  it("lists a parent, then its children", () => {
    const list = [p("c", 1, "a"), p("b", 2), p("a", 1)];
    expect(inOrder(list).map((x) => x.id)).toEqual(["a", "c", "b"]);
  });
});

describe("pathOf", () => {
  const list = [p("a", 1), p("c", 1, "a")];
  it("joins parent and child", () => expect(pathOf(list[1]!, list)).toBe("A › C"));
  it("gives a top-level project's name alone", () => expect(pathOf(list[0]!, list)).toBe("A"));
  it("gives a child with a missing parent its name alone", () =>
    expect(pathOf(p("o", 1, "gone"), list)).toBe("O"));
});

describe("homesFor", () => {
  const list = [p("a", 1), p("b", 2), p("c", 1, "a"), p("x", 3, null, "v2")];
  it("offers top-level projects of the same venture, not itself", () => {
    expect(homesFor(list[1]!, list).map((x) => x.id)).toEqual(["a"]);
  });
  it("offers a child the other top-level projects, its own parent included", () => {
    expect(homesFor(list[2]!, list).map((x) => x.id)).toEqual(["a", "b"]);
  });
  it("is empty when the project holds any project", () => {
    expect(homesFor(list[0]!, list)).toEqual([]);
  });
});
