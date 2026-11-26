import { describe, expect, it } from "vitest";
import type { ArchivedItem, Kind } from "@vemi/shared";
import { archiveList, keptKinds, restoreSteps, waitingOn, waitingSaid, type ArchiveFilter } from "./archiveList.js";

const item = (kind: Kind, id: string, label: string, archivedAt: string): ArchivedItem => ({ kind, id, label, archivedAt });

const filter = (typed = "", kinds: readonly Kind[] = []): ArchiveFilter => ({ typed, kinds: new Set(kinds) });

const ids = (items: readonly ArchivedItem[]) => items.map((i) => i.id);

const ARCHIVE: readonly ArchivedItem[] = [
  item("tasks", "t1", "File the return", "2026-09-10T00:00:00Z"),
  item("tags", "g1", "legal", "2026-09-12T00:00:00Z"),
  item("projects", "p1", "Legal review", "2026-09-11T00:00:00Z"),
  item("tasks", "t2", "Chase the invoice", "2026-09-14T00:00:00Z"),
  item("notes", "n1", "Called the accountant.\nShe says the  return is late.", "2026-09-09T00:00:00Z"),
  item("links", "l1", "https://www.icloud.com/notes/Legal-Pack", "2026-09-13T00:00:00Z"),
];

describe("archiveList", () => {
  it("shows everything, newest first, while nothing is typed or chosen", () => {
    const view = archiveList(ARCHIVE, filter());
    expect(ids(view.shown)).toEqual(["t2", "l1", "g1", "p1", "t1", "n1"]);
    expect(view.of).toBe(6);
  });

  it("matches what was typed anywhere in the label, without case or padding", () => {
    expect(ids(archiveList(ARCHIVE, filter("  LEGAL ")).shown)).toEqual(["l1", "g1", "p1"]);
    // Substring, not prefix: "turn" finds "the return".
    expect(ids(archiveList(ARCHIVE, filter("turn")).shown)).toEqual(["t1", "n1"]);
  });

  it("finds a note by its prose and a link by its address", () => {
    // A note's label is the start of its body, line breaks and doubled spaces and all.
    expect(ids(archiveList(ARCHIVE, filter("the return is")).shown)).toEqual(["n1"]);
    expect(ids(archiveList(ARCHIVE, filter("accountant. she")).shown)).toEqual(["n1"]);
    expect(ids(archiveList(ARCHIVE, filter("icloud.com/notes")).shown)).toEqual(["l1"]);
  });

  it("narrows to the kinds chosen, and an empty choice means every kind", () => {
    expect(ids(archiveList(ARCHIVE, filter("", ["tasks"])).shown)).toEqual(["t2", "t1"]);
    expect(ids(archiveList(ARCHIVE, filter("", ["tasks", "tags"])).shown)).toEqual(["t2", "g1", "t1"]);
    expect(archiveList(ARCHIVE, filter("", [])).shown).toHaveLength(6);
  });

  it("applies what was typed and the kinds chosen together", () => {
    expect(ids(archiveList(ARCHIVE, filter("legal", ["tags", "projects"])).shown)).toEqual(["g1", "p1"]);
    expect(archiveList(ARCHIVE, filter("invoice", ["notes"])).shown).toEqual([]);
  });

  it("offers only the kinds present, counted, in the model's order", () => {
    expect(archiveList(ARCHIVE, filter()).kinds).toEqual([
      { kind: "projects", of: 1 },
      { kind: "tasks", of: 2 },
      { kind: "notes", of: 1 },
      { kind: "links", of: 1 },
      { kind: "tags", of: 1 },
    ]);
  });

  it("counts kinds over what was typed but not over the kinds chosen, so a choice never hides its own options", () => {
    const narrowed = archiveList(ARCHIVE, filter("legal", ["tags"]));
    expect(ids(narrowed.shown)).toEqual(["g1"]);
    expect(narrowed.kinds).toEqual([
      { kind: "projects", of: 1 },
      { kind: "tasks", of: 0 },
      { kind: "notes", of: 0 },
      { kind: "links", of: 1 },
      { kind: "tags", of: 1 },
    ]);
    // The same counts as with no kind chosen at all.
    expect(narrowed.kinds).toEqual(archiveList(ARCHIVE, filter("legal")).kinds);
  });

  it("keeps offering a chosen kind that nothing typed matches, so it can still be let go of", () => {
    const view = archiveList(ARCHIVE, filter("invoice", ["tags"]));
    expect(view.shown).toEqual([]);
    expect(view.kinds.find((k) => k.kind === "tags")).toEqual({ kind: "tags", of: 0 });
    expect(view.of).toBe(6);
  });

  it("passes over a chosen kind the archive no longer holds, rather than showing nothing with no way out", () => {
    // The last tag was restored while tags were chosen: its chip is gone, so it cannot narrow.
    expect(ids(archiveList(ARCHIVE, filter("", ["ventures"])).shown)).toHaveLength(6);
    expect(ids(archiveList(ARCHIVE, filter("", ["ventures", "tags"])).shown)).toEqual(["g1"]);
  });

  it("answers an empty archive with nothing to show and nothing to offer", () => {
    expect(archiveList([], filter("legal", ["tasks"]))).toEqual({ shown: [], kinds: [], of: 0 });
  });

  it("keeps the order newest first however the list arrives, and does not touch the list it was given", () => {
    const given = [...ARCHIVE].reverse();
    const before = ids(given);
    expect(ids(archiveList(given, filter("", ["tasks"])).shown)).toEqual(["t2", "t1"]);
    expect(ids(given)).toEqual(before);
  });
});

describe("keptKinds", () => {
  it("lets go of a chosen kind once the archive no longer holds it", () => {
    // Tags chosen, the last tag restored: nothing narrows, and an undo that brings the tag
    // back must not quietly narrow the list to tags again.
    const withoutTags = ARCHIVE.filter((i) => i.kind !== "tags");
    expect([...keptKinds(withoutTags, new Set<Kind>(["tags", "tasks"]))]).toEqual(["tasks"]);
    expect(keptKinds(withoutTags, new Set<Kind>(["tags"])).size).toBe(0);
  });

  it("hands back the very same set when every chosen kind is still held, so nothing re-renders", () => {
    const chosen = new Set<Kind>(["tags", "tasks"]);
    expect(keptKinds(ARCHIVE, chosen)).toBe(chosen);
    const none = new Set<Kind>();
    expect(keptKinds([], none)).toBe(none);
  });
});

describe("restoreSteps", () => {
  /**
   * A Worker in miniature, holding the one rule that makes order matter: a state cannot be
   * archived while a live task sits in it.
   */
  const world = (archived: Iterable<string>, sitsIn: Readonly<Record<string, string>>) => {
    const put = new Set(archived);
    const calls: string[] = [];
    return {
      put,
      calls,
      archive: async (i: ArchivedItem) => {
        calls.push(`archive ${i.id}`);
        const inIt = Object.entries(sitsIn).some(([task, state]) => state === i.id && !put.has(task));
        if (i.kind === "states" && inIt) throw new Error("tasks or milestones sit in this state");
        put.add(i.id);
      },
      unarchive: async (i: ArchivedItem) => {
        calls.push(`unarchive ${i.id}`);
        put.delete(i.id);
      },
    };
  };

  // Listed newest first: the state went after its last task did, and an unrelated row between.
  const waiting = item("states", "s1", "Waiting", "2026-09-14T00:00:00Z");
  const other = item("notes", "n9", "Unrelated", "2026-09-15T00:00:00Z");
  const last = item("tasks", "t9", "Last one waiting", "2026-09-13T00:00:00Z");
  const back = [other, waiting, last];

  it("undoes a bulk restore in the order the rows were archived, so no row is refused part-way", async () => {
    const w = world([], { t9: "s1" });
    await restoreSteps(back, w).undo();
    expect(w.calls).toEqual(["archive t9", "archive s1", "archive n9"]);
    expect([...w.put].sort()).toEqual(["n9", "s1", "t9"]);
  });

  it("redoes it in the order the restore first ran, which the Worker already accepted", async () => {
    const w = world(["n9", "s1", "t9"], { t9: "s1" });
    const steps = restoreSteps(back, w);
    await steps.redo();
    expect(w.calls).toEqual(["unarchive n9", "unarchive s1", "unarchive t9"]);
    expect(w.put.size).toBe(0);
    // And round again: undo after redo is still whole.
    await steps.undo();
    expect([...w.put].sort()).toEqual(["n9", "s1", "t9"]);
  });

  it("reads the rows when the step runs, so it can be made before the restore fills them in", async () => {
    const filling: ArchivedItem[] = [];
    const w = world([], { t9: "s1" });
    const steps = restoreSteps(filling, w);
    filling.push(...back);
    await steps.undo();
    expect(w.calls).toEqual(["archive t9", "archive s1", "archive n9"]);
  });

  it("does not reorder the list it was given", async () => {
    const given = [...back];
    await restoreSteps(given, world([], { t9: "s1" })).undo();
    expect(given).toEqual(back);
  });
});

describe("waitingOn", () => {
  const studios = item("ventures", "v1", "Studios", "2026-09-14T00:00:00Z");
  const slice = item("projects", "p1", "Slice", "2026-09-13T00:00:00Z");

  it("names the archived venture a restored record still sits in", () => {
    expect(waitingOn({ id: "p1", ventureId: "v1" }, [studios])).toEqual([studios]);
  });

  it("names an archived project as well, the project before the venture", () => {
    expect(waitingOn({ id: "t1", ventureId: "v1", projectId: "p1" }, [studios, slice])).toEqual([slice, studios]);
  });

  it("names nothing when the parents are live, absent, or the answer was queued", () => {
    expect(waitingOn({ id: "p1", ventureId: "v2" }, [studios])).toEqual([]);
    expect(waitingOn({ id: "n1", ventureId: null, projectId: null }, [studios])).toEqual([]);
    expect(waitingOn({ id: "v1", name: "Studios" }, [studios])).toEqual([]);
    expect(waitingOn({ queued: true }, [studios])).toEqual([]);
    expect(waitingOn(null, [studios])).toEqual([]);
  });

  it("does not mistake a record of one kind for a parent of another with the same id", () => {
    expect(waitingOn({ id: "t1", ventureId: "p1" }, [slice])).toEqual([]);
  });

  describe("under an archived parent project", () => {
    const parent = { ...item("projects", "p0", "Chase", "2026-09-12T00:00:00Z"), holds: ["p1"] };

    it("names the parent of a restored child", () => {
      expect(waitingOn({ id: "p1", ventureId: "v1", parentId: "p0" }, [parent])).toEqual([parent]);
    });

    it("names the parent for a task in a live child of an archived parent, before the venture", () => {
      expect(waitingOn({ id: "t1", ventureId: "v1", projectId: "p1" }, [studios, parent])).toEqual([parent, studios]);
    });

    it("says nothing when the parent was restored in the same pass", () => {
      expect(waitingOn({ id: "p1", ventureId: "v2", parentId: "p0" }, [])).toEqual([]);
      expect(waitingOn({ id: "t1", ventureId: "v2", projectId: "p1" }, [])).toEqual([]);
    });

    it("names the parent once when child and parent are both reached", () => {
      expect(waitingOn({ id: "t1", projectId: "p1", parentId: "p0" }, [parent])).toEqual([parent]);
    });
  });
});

describe("waitingSaid", () => {
  const studios = item("ventures", "v1", "Studios", "2026-09-14T00:00:00Z");
  const home = item("ventures", "v2", "Home", "2026-09-14T00:00:00Z");
  const slice = item("projects", "p1", "Slice", "2026-09-13T00:00:00Z");

  it("says once what one restored thing waits for", () => {
    expect(waitingSaid([{ label: "Slice", on: [studios] }])).toBe("Slice shows once Studios is restored.");
  });

  it("gathers the things that wait for the same parents into one sentence", () => {
    expect(waitingSaid([
      { label: "Slice", on: [studios] },
      { label: "Chase", on: [slice, studios] },
      { label: "Bake", on: [studios] },
      { label: "Tidy", on: [home] },
      { label: "Loose", on: [] },
    ])).toBe(
      "Slice and Bake show once Studios is restored. Chase shows once Slice and Studios are restored. " +
      "Tidy shows once Home is restored.",
    );
  });

  it("says nothing when nothing waits", () => {
    expect(waitingSaid([])).toBe("");
    expect(waitingSaid([{ label: "Loose", on: [] }])).toBe("");
  });
});
