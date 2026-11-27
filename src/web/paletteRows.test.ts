import { describe, expect, it } from "vitest";
import { levelWords } from "./levelWords.js";
import { paletteSections, type PaletteSource } from "./paletteRows.js";
import { HOME, projectPage, surface, venture } from "./router.js";

const words = levelWords();
const last = { id: "v1", name: "Studios" };
const spaceName = (id: string): string => (id === "v1" ? "Studios" : "Farm");

const projects = [
  { id: "p1", ventureId: "v1", name: "Launch site", pinnedAt: null },
  { id: "p2", ventureId: "v1", name: "Annual tax", pinnedAt: "2026-11-02T00:00:00.000Z" },
  { id: "p3", ventureId: "v2", name: "Fence line", pinnedAt: "2026-11-01T00:00:00.000Z" },
];
const tasks = [
  { id: "t1", ventureId: "v1", title: "Order the tax forms" },
  { id: "t2", ventureId: "v2", title: "Buy fence posts" },
];
const source: PaletteSource = { words, last, projects, tasks, spaceName };
const titles = (typed: string, group: string, from: PaletteSource = source): string[] =>
  paletteSections(typed, from).find((s) => s.name === group)?.rows.map((r) => r.title) ?? [];

describe("the palette with nothing typed", () => {
  const sections = paletteSections("", source);

  it("groups actions, places, pinned projects, then the other projects, and no tasks", () => {
    expect(sections.map((s) => s.name)).toEqual(["Actions", "Go to", "Pinned", "Projects"]);
    expect(titles("", "Actions")).toEqual(["New task", "New project", "Weekly review"]);
    expect(titles("", "Go to")).toEqual(["Map", "Today", "Search", "Archive", "Account"]);
  });

  it("lists the longest pinned first, and the rest under Projects", () => {
    expect(titles("", "Pinned")).toEqual(["Fence line", "Annual tax"]);
    expect(titles("", "Projects")).toEqual(["Launch site"]);
  });

  it("sends each row where it lives", () => {
    const rows = sections.flatMap((s) => s.rows);
    const to = (key: string) => rows.find((r) => r.key === key)?.to;
    expect(to("do:new-task")).toBe("compose");
    expect(to("do:new-project")).toEqual(venture("v1", "projects"));
    expect(to("do:review")).toEqual(surface("review"));
    expect(to("go:map")).toEqual(HOME);
    expect(to("go:search")).toEqual(surface("search"));
    expect(to("pinned:p2")).toEqual(projectPage("v1", "p2"));
  });

  it("carries the keys that reach the same places, for a desk to show", () => {
    const rows = sections.flatMap((s) => s.rows);
    const hint = (key: string) => rows.find((r) => r.key === key)?.hint;
    expect([hint("do:new-task"), hint("do:new-project"), hint("go:map"), hint("go:today"), hint("go:search")]).toEqual(["N", "P", "G M", "G T", "G S"]);
  });

  it("uses the level words a person chose", () => {
    const named = paletteSections("", { ...source, words: levelWords({ task: "Job", project: "Build" }) });
    expect(named[0]?.rows.map((r) => r.title)).toEqual(["New job", "New build", "Weekly review"]);
  });

  it("names the other groups and row kinds with the level words a person chose", () => {
    const named = { ...source, words: levelWords({ task: "Job", project: "Build" }) };
    expect(paletteSections("", named).map((s) => s.name)).toEqual(["Actions", "Go to", "Pinned", "Builds"]);
    const kinds = paletteSections("", named).flatMap((s) => s.rows).filter((r) => r.key.startsWith("pinned:") || r.key.startsWith("project:"));
    expect(kinds.map((r) => r.kind)).toEqual(["Build", "Build", "Build"]);
    const typed = paletteSections("tax", named);
    expect(typed.map((s) => s.name)).toEqual(["Pinned", "Jobs"]);
    expect(typed.flatMap((s) => s.rows).map((r) => r.kind)).toEqual(["Build", "Job"]);
  });

  it("puts new project on the map when no space was open", () => {
    const rows = paletteSections("", { ...source, last: null }).flatMap((s) => s.rows);
    expect(rows.find((r) => r.key === "do:new-project")?.to).toEqual(HOME);
  });
});

describe("the palette with a word typed", () => {
  it("keeps only what the word matches, in every group", () => {
    expect(paletteSections("tax", source).map((s) => [s.name, s.rows.map((r) => r.title)])).toEqual([
      ["Pinned", ["Annual tax"]],
      ["Tasks", ["Order the tax forms"]],
    ]);
  });

  it("orders a group by fuzzy score, a word that starts beating one that sits inside", () => {
    const two = { ...source, tasks: [{ id: "a", ventureId: "v1", title: "Contax" }, { id: "b", ventureId: "v1", title: "Tax return" }] };
    expect(titles("tax", "Tasks", two)).toEqual(["Tax return", "Contax"]);
  });

  it("matches words in any order", () => {
    expect(titles("posts buy", "Tasks")).toEqual(["Buy fence posts"]);
  });

  it("finds an action and a place by their words", () => {
    expect(titles("rev", "Actions")).toEqual(["Weekly review"]);
    expect(titles("today", "Go to")).toEqual(["Today"]);
  });

  it("opens a task on its space's board with its sheet open", () => {
    const row = paletteSections("fence posts", source).flatMap((s) => s.rows).find((r) => r.key === "task:t2");
    expect(row?.to).toEqual(venture("v2", "board", "t2"));
    expect(row?.where).toBe("Farm");
  });
});

describe("the palette when nothing matches", () => {
  it("offers a new task named by the typed text", () => {
    const out = paletteSections("  zzzq  ", source);
    expect(out).toHaveLength(1);
    expect(out[0]?.rows).toEqual([{ key: "do:new-task", kind: "Add", title: "New task", where: "zzzq", to: "compose" }]);
  });

  it("does not offer it when something matched", () => {
    expect(paletteSections("tax", source).flatMap((s) => s.rows).some((r) => r.key === "do:new-task")).toBe(false);
  });
});

describe("spaces in the palette", () => {
  it("finds a space by name and goes to it", async () => {
    const { paletteSections: sections } = await import("./paletteRows.js");
    const { levelWords: lw } = await import("./levelWords.js");
    const found = sections("dingo", { words: lw({}), last: null, projects: [], tasks: [], spaceName: () => "", spaces: [{ id: "v1", name: "Black Dingo Studios" }] });
    expect(found.flatMap((s) => s.rows).map((r) => r.title)).toContain("Black Dingo Studios");
  });
});
