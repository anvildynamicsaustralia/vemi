import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Change } from "@vemi/shared";
import { callTool, connectorGate, toolList, type ToolDeps, type ToolResult } from "./connectorTools.js";
import { openStore, type Store } from "./store.js";
import { testDb, type TestDb } from "./testing/d1.js";

/** Every connector tool, through the real store and a real D1. */

const NOW = new Date("2026-11-18T02:00:00Z");
const ZONE = "Australia/Sydney";

let t: TestDb;
let store: Store;
let changes: { owner: string; change: Change }[] = [];
let gate: ToolDeps["gate"];

const deps = (): ToolDeps => ({
  store, now: () => NOW, timeZone: ZONE, gate,
  publish: (owner, change) => { changes.push({ owner, change }); },
});

beforeAll(async () => {
  t = await testDb();
  store = openStore({ DB: t.db }, () => NOW);
});
afterAll(() => t.dispose());

const data = (r: ToolResult | null): any => JSON.parse(r?.content[0]?.text ?? "null");
const message = (r: ToolResult | null): string => r?.content[0]?.text ?? "";

async function person() {
  const owner = `owner-${crypto.randomUUID()}`;
  expect(await store.createAccount({ id: owner, email: `${owner}@example.test`, passwordHash: "x", googleSub: null, confirmed: true })).toBe(true);
  const space = good(await store.create(owner, "ventures", { name: "Workshop" })).record;
  const project = good(await store.create(owner, "projects", { ventureId: space.id, name: "Shed" })).record;
  const milestone = good(await store.create(owner, "milestones", { projectId: project.id, name: "Frame up" })).record;
  const call = async (name: string, args?: unknown) => callTool(deps(), owner, name, args);
  return { owner, space, project, milestone, call };
}

function good<T>(o: { ok: true; value: T } | { ok: false; error: string }): T {
  if (!o.ok) throw new Error(o.error);
  return o.value;
}

describe("the tool list", () => {
  const tools = toolList();
  it("names every tool the plan lists", () => {
    expect(tools.map((x) => x.name).sort()).toEqual([
      "add_note", "add_project", "add_task", "complete_task", "get_project", "get_task",
      "overview", "pick_for_today", "search", "today", "update_brief", "update_task",
    ]);
  });
  it("has no tool that deletes or archives", () => {
    for (const x of tools) expect(x.name).not.toMatch(/delete|remove|archive|destroy|erase|purge|forget/i);
  });
  it("describes each tool in one sentence", () => {
    for (const x of tools) {
      expect(x.description.endsWith(".")).toBe(true);
      expect(x.description.slice(0, -1)).not.toMatch(/[.!?]\s/);
    }
  });
  it("reads level words from the words argument", () => {
    const named = toolList({ space: "Realm", project: "Quest", milestone: "Gate", task: "Chore" });
    const get = (n: string) => named.find((x) => x.name === n)?.description ?? "";
    expect(get("add_project")).toBe("Adds a quest to a realm.");
    expect(get("add_task")).toContain("chore");
    expect(get("add_task")).not.toContain("task");
  });
  it("marks reads as read-only and writes as not", () => {
    for (const x of tools) expect(x.annotations.readOnlyHint).toBe(["overview", "today", "search", "get_project", "get_task"].includes(x.name));
  });
});

describe("the gate", () => {
  it("allows today", async () => {
    expect(await connectorGate("anyone")).toEqual({ allowed: true });
  });
  it("is asked first, and a refusal runs nothing", async () => {
    const p = await person();
    const before = changes.length;
    gate = async () => ({ allowed: false, reason: "Not on this plan." });
    try {
      const r = await p.call("add_task", { title: "Nope", space: p.space.id });
      expect(r?.isError).toBe(true);
      expect(message(r)).toBe("Not on this plan.");
      expect(changes.length).toBe(before);
      expect(good(await store.list(p.owner, "tasks", {}))).toHaveLength(0);
    } finally { gate = undefined; }
  });
});

describe("read tools", () => {
  it("overview lists the person's spaces", async () => {
    const p = await person();
    const r = data(await p.call("overview"));
    expect(r.map((x: { name: string }) => x.name)).toEqual(["Workshop"]);
  });

  it("today lists what was picked", async () => {
    const p = await person();
    const added = data(await p.call("add_task", { title: "Sand the bench", project: "Shed" }));
    expect(data(await p.call("today")).tasks).toHaveLength(0);
    await p.call("pick_for_today", { task: added.id });
    const r = data(await p.call("today"));
    expect(r.on).toBe("2026-11-18");
    expect(r.tasks.map((x: { title: string }) => x.title)).toEqual(["Sand the bench"]);
  });

  it("search finds by text and narrows by scope", async () => {
    const p = await person();
    await p.call("add_task", { title: "Buy hinges", space: "Workshop" });
    await p.call("add_note", { project: "Shed", text: "hinges are brass" });
    expect(data(await p.call("search", { text: "hinges" })).map((h: { kind: string }) => h.kind).sort()).toEqual(["note", "task"]);
    expect(data(await p.call("search", { text: "hinges", scope: "note" }))).toHaveLength(1);
    expect(message(await p.call("search", { text: "hinges", scope: "nope" }))).toMatch(/scope must be one of/);
    expect(message(await p.call("search", { text: "  " }))).toBe("text is needed");
  });

  it("get_project gives the brief, milestones, tasks and recent notes", async () => {
    const p = await person();
    await p.call("update_brief", { project: "Shed", field: "whoFor", text: "Me" });
    await p.call("add_note", { project: p.project.id, text: "first" });
    await p.call("add_task", { title: "Pour slab", project: "Shed", milestone: "Frame up" });
    const r = data(await p.call("get_project", { project: "shed" }));
    expect(r.brief.whoFor).toBe("Me");
    expect(r.milestones.map((m: { name: string }) => m.name)).toEqual(["Frame up"]);
    expect(r.tasks.map((x: { title: string }) => x.title)).toEqual(["Pour slab"]);
    expect(r.tasks[0].milestoneId).toBe(p.milestone.id);
    expect(r.notes.map((n: { body: string }) => n.body)).toEqual(["first"]);
  });

  it("get_task reads one task", async () => {
    const p = await person();
    const added = data(await p.call("add_task", { title: "Hang door", space: "Workshop" }));
    expect(data(await p.call("get_task", { task: added.id })).title).toBe("Hang door");
  });
});

describe("write tools", () => {
  it("add_task reads smart dates out of the title and publishes the change", async () => {
    const p = await person();
    changes = [];
    const r = data(await p.call("add_task", { title: "Call the council tomorrow at 9am every monday", space: "Workshop" }));
    expect(r.title).toBe("Call the council");
    expect(r.dueOn).toBe("2026-11-19");
    expect(r.repeat).toBe("week:1");
    expect(r.remindAt).toBe("2026-11-19T09:00");
    expect(changes).toEqual([{ owner: p.owner, change: { kind: "tasks", id: r.id, ventureId: p.space.id } }]);
  });

  it("add_task lets an explicit argument beat the title, and needs only a title and a space", async () => {
    const p = await person();
    const r = data(await p.call("add_task", { title: "Pay rates tomorrow", space: p.space.id, when: "2026-12-01", reminder: "2026-12-01T08:30", repeat: "month" }));
    expect(r).toMatchObject({ title: "Pay rates", dueOn: "2026-12-01", remindAt: "2026-12-01T08:30", repeat: "month" });
    // The only space is where it goes when none is named.
    expect(data(await p.call("add_task", { title: "Plain" })).ventureId).toBe(p.space.id);
  });

  it("add_task puts a task under a project and a milestone, and says plainly what it cannot find", async () => {
    const p = await person();
    const r = data(await p.call("add_task", { title: "Square it", project: "Shed", milestone: "Frame up" }));
    expect(r).toMatchObject({ ventureId: p.space.id, projectId: p.project.id, milestoneId: p.milestone.id });
    expect(message(await p.call("add_task", { title: "x", project: "Nowhere" }))).toBe("no project is called Nowhere");
    expect(message(await p.call("add_task", { title: "x", project: "Shed", milestone: "Nowhere" }))).toBe("no milestone is called Nowhere");
    expect(message(await p.call("add_task", { title: "x", space: "Nowhere" }))).toBe("no space is called Nowhere");
  });

  it("update_task changes the title, date, reminder, repeat, project and milestone, and clears with none", async () => {
    const p = await person();
    const t0 = data(await p.call("add_task", { title: "Old", space: "Workshop", when: "2026-11-20", repeat: "day" }));
    const r = data(await p.call("update_task", { task: t0.id, title: "New", when: "friday", reminder: "2026-11-20T10:00", repeat: "none", project: "Shed", milestone: "Frame up" }));
    expect(r).toMatchObject({ title: "New", dueOn: "2026-11-20", remindAt: "2026-11-20T10:00", repeat: null, projectId: p.project.id, milestoneId: p.milestone.id });
    const cleared = data(await p.call("update_task", { task: t0.id, when: "none", project: "none" }));
    expect(cleared).toMatchObject({ dueOn: null, projectId: null, milestoneId: null });
  });

  it("complete_task finishes and reopens, and a repeating one spawns its next", async () => {
    const p = await person();
    const t0 = data(await p.call("add_task", { title: "Sweep", space: "Workshop" }));
    const done = data(await p.call("complete_task", { task: t0.id }));
    const states = good(await store.list(p.owner, "states", { venture: p.space.id }));
    expect(states.find((s) => s.id === done.stateId)?.kind).toBe("finished");
    const open = data(await p.call("complete_task", { task: t0.id, done: false }));
    expect(states.find((s) => s.id === open.stateId)?.kind).not.toBe("finished");

    const rep = data(await p.call("add_task", { title: "Water plants every day", space: "Workshop" }));
    changes = [];
    await p.call("complete_task", { task: rep.id });
    expect(changes.filter((c) => c.change.kind === "tasks")).toHaveLength(2);
    expect(good(await store.list(p.owner, "tasks", {})).filter((x) => x.title === "Water plants")).toHaveLength(2);
  });

  it("pick_for_today picks and unpicks", async () => {
    const p = await person();
    const t0 = data(await p.call("add_task", { title: "Pick me", space: "Workshop" }));
    expect(data(await p.call("pick_for_today", { task: t0.id })).pickedOn).toBe("2026-11-18");
    expect(data(await p.call("pick_for_today", { task: t0.id, on: false })).pickedOn).toBeNull();
    // Today is the caller's today when a zone is named.
    expect(data(await p.call("pick_for_today", { task: t0.id, timeZone: "America/Los_Angeles" })).pickedOn).toBe("2026-11-17");
  });

  it("add_project adds a project to a space", async () => {
    const p = await person();
    changes = [];
    const r = data(await p.call("add_project", { space: "Workshop", name: "Gate" }));
    expect(r).toMatchObject({ name: "Gate", ventureId: p.space.id });
    expect(changes[0]?.change).toEqual({ kind: "projects", id: r.id, ventureId: p.space.id });
  });

  it("add_note adds a note to a project", async () => {
    const p = await person();
    const r = data(await p.call("add_note", { project: "Shed", text: "Bring gloves" }));
    expect(r).toMatchObject({ body: "Bring gloves", projectId: p.project.id });
  });

  it("update_brief writes one field of the brief", async () => {
    const p = await person();
    const r = data(await p.call("update_brief", { project: "Shed", field: "doneLooks", text: "Doors close" }));
    expect(r.doneLooks).toBe("Doors close");
    expect(r.whoFor).toBeNull();
    expect(message(await p.call("update_brief", { project: "Shed", field: "name", text: "x" }))).toMatch(/field must be/);
  });
});

describe("bad input", () => {
  it("answers in a plain sentence, never a crash", async () => {
    const p = await person();
    const say = async (name: string, args?: unknown) => { const r = await p.call(name, args); expect(r?.isError).toBe(true); return message(r); };
    expect(await say("add_task", {})).toBe("title is needed");
    expect(await say("add_task", { title: "x", space: "Workshop", colour: "red" })).toBe("add_task has no argument colour");
    expect(await say("add_task", { title: 4 })).toBe("title must be text");
    expect(await say("add_task", { title: "x", when: "someday" })).toMatch(/^when must be a date/);
    expect(await say("add_task", { title: "x", repeat: "sometimes" })).toMatch(/^repeat must be/);
    expect(await say("add_task", { title: "x", reminder: "later" })).toMatch(/^reminder must be/);
    expect(await say("add_task", { title: "x", milestone: "Frame up", space: "Workshop" })).toMatch(/needs its project/);
    expect(await say("get_task", { task: "nope" })).toBe("task nope was not found");
    expect(await say("complete_task", { task: "nope", done: "yes" })).toBe("done must be true or false");
    expect(await say("today", { timeZone: "Mars/Base" })).toMatch(/timeZone must be/);
    expect(await say("overview", "string")).toBe("the arguments must be an object");
    expect(await callTool(deps(), p.owner, "delete_task", {})).toBeNull();
  });
});

describe("another account", () => {
  it("is unreachable by id, name, search and overview", async () => {
    const a = await person();
    const b = await person();
    const theirs = data(await b.call("add_task", { title: "Secret plan", project: "Shed" }));
    const gone = (m: string) => expect(m).toMatch(/was not found|no .* is called|needs/);

    gone(message(await a.call("get_task", { task: theirs.id })));
    gone(message(await a.call("update_task", { task: theirs.id, title: "mine now" })));
    gone(message(await a.call("complete_task", { task: theirs.id })));
    gone(message(await a.call("pick_for_today", { task: theirs.id })));
    gone(message(await a.call("add_task", { title: "x", space: b.space.id })));
    gone(message(await a.call("add_task", { title: "x", project: b.project.id })));
    gone(message(await a.call("add_project", { space: b.space.id, name: "x" })));
    gone(message(await a.call("add_note", { project: b.project.id, text: "x" })));
    gone(message(await a.call("update_brief", { project: b.project.id, field: "whoFor", text: "x" })));
    expect(data(await a.call("search", { text: "Secret" }))).toEqual([]);
    expect(data(await a.call("overview")).map((x: { id: string }) => x.id)).toEqual([a.space.id]);
    expect((await store.get(b.owner, "tasks", theirs.id))?.title).toBe("Secret plan");
  });
});
