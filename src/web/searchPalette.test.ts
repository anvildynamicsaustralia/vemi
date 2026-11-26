import { describe, expect, it } from "vitest";
import type { SearchHit } from "@vemi/shared";
import { HOME, projectPage, surface, venture } from "./router.js";
import { commandsFor, hitReach, hitRoute, NEW_TASK, pinRows, places, type Pinnable } from "./searchPalette.js";

const hit = (over: Partial<SearchHit> & Pick<SearchHit, "kind">): SearchHit =>
  ({ id: "x", ventureId: "v", projectId: null, taskId: null, text: "x", ...over });

describe("the places an empty search lists", () => {
  it("are the rail's places, with no venture open", () => {
    expect(places(null).map((r) => [r.title, r.to])).toEqual([
      ["Map", HOME], ["Today", surface("today")], ["Weekly review", surface("review")], ["Archive", surface("archive")],
      ["Account", surface("account")],
    ]);
  });

  it("add the two tabs of the venture last open", () => {
    const tabs = places({ id: "v1", name: "Studios" }).slice(5);
    expect(tabs.map((r) => [r.title, r.where, r.to])).toEqual([
      ["Board", "Studios", venture("v1", "board")],
      ["Projects", "Studios", venture("v1", "projects")],
    ]);
  });
});

describe("the places and the verb a typed word lists", () => {
  const rows = places({ id: "v1", name: "Fence Farm" });

  it("are the ones with a word starting with it, case-blind", () => {
    expect(commandsFor("TOD", rows).map((r) => r.title)).toEqual(["Today"]);
    expect(commandsFor("tas", rows)).toEqual([NEW_TASK]);
    expect(commandsFor("farm", rows).map((r) => r.title)).toEqual(["Board", "Projects"]);
  });

  it("are none for one letter, or a word in the middle of a name", () => {
    expect(commandsFor("a", rows)).toEqual([]);
    expect(commandsFor("izon", rows)).toEqual([]);
  });
});

describe("where a hit opens", () => {
  it("is the page that holds it", () => {
    expect(hitRoute(hit({ kind: "venture", id: "v" }))).toEqual(venture("v", "board"));
    expect(hitRoute(hit({ kind: "project", id: "p" }))).toEqual(projectPage("v", "p"));
    expect(hitRoute(hit({ kind: "task", id: "t" }))).toEqual(venture("v", "board", "t"));
    expect(hitRoute(hit({ kind: "milestone", projectId: "p" }))).toEqual(projectPage("v", "p"));
    expect(hitRoute(hit({ kind: "decision", projectId: "p" }))).toEqual(projectPage("v", "p"));
    expect(hitRoute(hit({ kind: "risk" }))).toEqual(venture("v", "projects"));
    expect(hitRoute(hit({ kind: "note", taskId: "t", projectId: "p" }))).toEqual(venture("v", "board", "t"));
    expect(hitRoute(hit({ kind: "link", projectId: "p" }))).toEqual(projectPage("v", "p"));
    expect(hitRoute(hit({ kind: "note" }))).toEqual(venture("v", "projects"));
  });
});

describe("what a hit asks its page to bring into view", () => {
  it("is the ledger of the project or the venture for a decision or a risk", () => {
    expect(hitReach(hit({ kind: "decision", projectId: "p" }))).toEqual({ id: "p", reach: "ledger" });
    expect(hitReach(hit({ kind: "risk" }))).toEqual({ id: "v", reach: "ledger" });
  });

  it("is the venture's About for a note or a link on it, which sit there, closed", () => {
    expect(hitReach(hit({ kind: "note" }))).toEqual({ id: "v", reach: "about" });
    expect(hitReach(hit({ kind: "link" }))).toEqual({ id: "v", reach: "about" });
    expect(hitReach(hit({ kind: "note", projectId: "p" }))).toBeNull();
    expect(hitReach(hit({ kind: "link", taskId: "t", projectId: "p" }))).toBeNull();
  });

  it("is none for what is on screen where it opens", () => {
    for (const kind of ["venture", "project", "milestone", "task"] as const) expect(hitReach(hit({ kind, projectId: "p" }))).toBeNull();
  });
});

describe("pinned projects in the palette", () => {
  const project = (id: string, name: string, pinnedAt: string | null): Pinnable => ({ id, ventureId: "v", name, pinnedAt });
  const all = [
    project("a", "Alpha", null),
    project("b", "Bravo", "2026-11-02T00:00:00.000Z"),
    project("c", "Charlie", "2026-11-01T00:00:00.000Z"),
  ];

  it("offers Pin for a loose project and Unpin for a pinned one, pinned first", () => {
    const { pinned, commands } = pinRows(all, () => "Studios");
    expect(pinned.map((r) => r.title)).toEqual(["Charlie", "Bravo"]);
    expect(commands.map((r) => [r.title, r.to])).toEqual([
      ["Unpin Charlie", { pin: "c", set: false }],
      ["Unpin Bravo", { pin: "b", set: false }],
      ["Pin Alpha", { pin: "a", set: true }],
    ]);
  });

  it("finds Pin and Unpin by a typed word, pinned projects first", () => {
    const { commands } = pinRows(all, () => "Studios");
    expect(commandsFor("alp", commands).map((r) => r.title)).toEqual(["Pin Alpha"]);
    expect(commandsFor("unpin", commands).map((r) => r.title)).toEqual(["Unpin Charlie", "Unpin Bravo"]);
  });
});
