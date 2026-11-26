import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { open, sealRecord, type EncryptedKind } from "@vemi/shared";
import {
  ApiError, api, paths, read, renameSavedFilter, saveDefaultStages, saveFilter, saveLevelNames,
} from "./api.js";
import {
  LOCKED_WORD, forgetSealed, refreshEncryption, setEncryptionState, setKeySource, sealOutgoing, type HeldKey,
} from "./sealedApi.js";
import { ownOutbox, queued } from "./state/outbox.js";

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() { return values.size; },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (i) => [...values.keys()][i] ?? null,
    removeItem: (key) => { values.delete(key); },
    setItem: (key, value) => { values.set(key, String(value)); },
  };
}

const REF = "abcdefghijk";
let held: HeldKey;
let other: HeldKey;

async function makeKey(ref: string): Promise<HeldKey> {
  const fieldKey = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  return { fieldKey, keyRef: ref };
}

/** What the Worker would hold: the row, sealed as the device seals it. */
async function stored<T extends object>(kind: EncryptedKind, row: T, key: HeldKey = held): Promise<T> {
  return (await sealRecord(key.fieldKey, key.keyRef, kind, row)).row;
}

interface Sent { readonly url: string; readonly method: string; readonly body: string | null }
let sent: Sent[];
let answers: (url: string, init: RequestInit) => unknown;
let down: boolean;

beforeEach(async () => {
  held = await makeKey(REF);
  other = await makeKey("zzzzzzzzzzz");
  vi.stubGlobal("localStorage", memoryStorage());
  sent = [];
  down = false;
  answers = () => ({});
  vi.stubGlobal("fetch", async (input: string, init: RequestInit = {}) => {
    sent.push({ url: input, method: init.method ?? "GET", body: typeof init.body === "string" ? init.body : null });
    if (down) throw new TypeError("Failed to fetch");
    return new Response(JSON.stringify(answers(input, init)), { status: 200, headers: { "content-type": "application/json" } });
  });
  ownOutbox("a@example.com");
  setKeySource(async () => held);
  setEncryptionState("on");
});

afterEach(() => {
  ownOutbox(null);
  setKeySource(null);
  forgetSealed();
  vi.unstubAllGlobals();
});

const everything = (): string => sent.map((s) => `${s.url} ${s.body ?? ""}`).join("\n");

describe("with the switch off", () => {
  it("sends the same bytes it always did and reads the answer as it came", async () => {
    forgetSealed();
    answers = (_u, init) => JSON.parse(String(init.body));
    await api.create("tasks", { id: "t1", ventureId: "v1", title: "Plain title", checklist: [{ text: "step", done: false }] });
    expect(sent[0]?.body).toBe(JSON.stringify({ id: "t1", ventureId: "v1", title: "Plain title", checklist: [{ text: "step", done: false }] }));
    await api.update("tasks", "t1", { title: "Newer" });
    expect(sent[1]?.body).toBe(JSON.stringify({ title: "Newer" }));
    await saveFilter("Mine", "words");
    expect(sent[2]?.body).toBe(JSON.stringify({ name: "Mine", query: "words" }));
    await saveLevelNames({ space: "Realm" });
    expect(sent[3]?.body).toBe(JSON.stringify({ levelNames: { space: "Realm" } }));
    const body = { ventures: [{ id: "v", name: "n" }] };
    answers = () => body;
    expect((await read(paths.overview)).data).toEqual(body);
  });
});

describe("a write with the switch on", () => {
  it("seals a create, binds it to the client id and opens the answer", async () => {
    answers = (_u, init) => ({ ...JSON.parse(String(init.body)), position: 1 });
    const made = await api.create("tasks", { ventureId: "v1", title: "Secret title", body: null, checklist: [{ text: "secret step", done: true }] });
    const body = JSON.parse(sent[0]?.body ?? "{}") as { id: string; title: string; ventureId: string; body: null; checklist: { text: string; done: boolean }[] };
    expect(everything()).not.toContain("Secret title");
    expect(everything()).not.toContain("secret step");
    expect(body.ventureId).toBe("v1");
    expect(body.body).toBeNull();
    expect(body.checklist[0]?.done).toBe(true);
    expect(typeof body.id).toBe("string");
    expect(await open(held.fieldKey, body.title, { record: body.id, field: "title" })).toBe("Secret title");
    expect(await open(held.fieldKey, body.checklist[0]?.text ?? "", { record: body.id, field: "checklist.text" })).toBe("secret step");
    expect((made as { title: string }).title).toBe("Secret title");
  });

  it("seals an edit to the record named in the address, and sends no id", async () => {
    answers = () => ({});
    await api.update("projects", "p1", { name: "Quiet name", position: 4 });
    const body = JSON.parse(sent[0]?.body ?? "{}") as { name: string; position: number; id?: string };
    expect(body.id).toBeUndefined();
    expect(body.position).toBe(4);
    expect(await open(held.fieldKey, body.name, { record: "p1", field: "name" })).toBe("Quiet name");
    expect(everything()).not.toContain("Quiet name");
  });

  it("sends a change with no text as it is, key or no key", async () => {
    setKeySource(null);
    await api.update("tasks", "t1", { position: 2 });
    expect(sent[0]?.body).toBe(JSON.stringify({ position: 2 }));
  });

  it("keeps only envelopes in the outbox when the Worker cannot be reached", async () => {
    down = true;
    const result = await api.create("tasks", { id: "t-offline", ventureId: "v1", title: "Written on a train" });
    expect(result).toEqual({ queued: true });
    const rows = queued();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.body).not.toContain("Written on a train");
    const body = JSON.parse(rows[0]?.body ?? "{}") as { id: string; title: string };
    expect(body.id).toBe("t-offline");
    expect(await open(held.fieldKey, body.title, { record: "t-offline", field: "title" })).toBe("Written on a train");
  });

  it("refuses text it cannot seal when this device holds no key, and sends nothing", async () => {
    setKeySource(null);
    await expect(api.create("tasks", { ventureId: "v1", title: "No key here" })).rejects.toBeInstanceOf(ApiError);
    expect(sent).toHaveLength(0);
    expect(queued()).toHaveLength(0);
  });

  it("seals level names and default stages through the appearance route", async () => {
    await saveLevelNames({ space: "Realm", task: null });
    await saveDefaultStages([{ name: "Idea", kind: "open" }]);
    const names = JSON.parse(sent[0]?.body ?? "{}") as { levelNames: { space: string; task: null } };
    expect(names.levelNames.task).toBeNull();
    expect(await open(held.fieldKey, names.levelNames.space, { record: "settings", field: "levelSpace" })).toBe("Realm");
    const stages = JSON.parse(sent[1]?.body ?? "{}") as { defaultStages: string };
    expect(typeof stages.defaultStages).toBe("string");
    expect(JSON.parse(await open(held.fieldKey, stages.defaultStages, { record: "settings", field: "defaultStages" }))).toEqual([{ name: "Idea", kind: "open" }]);
    expect(everything()).not.toContain("Realm");
    expect(everything()).not.toContain("Idea");
  });

  it("gives a saved filter a client id and seals its name and query", async () => {
    answers = (_u, init) => JSON.parse(String(init.body));
    await saveFilter("Quick list", "needle words");
    const made = JSON.parse(sent[0]?.body ?? "{}") as { id: string; name: string; query: string };
    expect(made.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(await open(held.fieldKey, made.name, { record: made.id, field: "name" })).toBe("Quick list");
    expect(await open(held.fieldKey, made.query, { record: made.id, field: "query" })).toBe("needle words");
    await renameSavedFilter(made.id, "Renamed list");
    const renamed = JSON.parse(sent[1]?.body ?? "{}") as { name: string; id?: string };
    expect(renamed.id).toBeUndefined();
    expect(await open(held.fieldKey, renamed.name, { record: made.id, field: "name" })).toBe("Renamed list");
    expect(everything()).not.toContain("needle words");
    expect(everything()).not.toContain("Renamed list");
  });

  it("holds no plaintext in any address or body across a run of writes", async () => {
    const words = ["Alpha venture", "Beta project", "Gamma milestone", "Delta decision", "Epsilon link", "Zeta tag"];
    await api.create("ventures", { name: words[0] });
    await api.create("projects", { ventureId: "v", name: words[1] });
    await api.create("milestones", { projectId: "p", name: words[2] });
    await api.create("decisions", { projectId: "p", title: words[3], body: "Delta body" });
    await api.create("links", { projectId: "p", url: "https://example.com/epsilon", label: words[4] });
    await api.create("tags", { name: words[5] });
    await api.archive("tags", "tag-1");
    const all = everything();
    for (const w of [...words, "Delta body", "example.com"]) expect(all).not.toContain(w);
  });
});

describe("a read with the switch on", () => {
  it("opens the tree, including blockers, checklists and states", async () => {
    const task = await stored("tasks", { id: "t1", title: "Task title", body: "Task body", checklist: [{ text: "check", done: false }], blocker: null });
    const blocker = await stored("blockers", { id: "b1", reason: "Waiting on tax", person: "Sam" });
    const tree = {
      ventures: [{
        ...(await stored("ventures", { id: "v1", name: "Venture name", description: "About it", monogram: "VN" })),
        states: [await stored("states", { id: "s1", name: "Doing", kind: "active" })],
        stages: [await stored("stages", { id: "g1", name: "Launch", kind: "open" })],
        tasks: [{ ...task, blocker: { ...blocker } }],
        projects: [{
          ...(await stored("projects", { id: "p1", name: "Project name" })),
          milestones: [await stored("milestones", { id: "m1", name: "Milestone name" })],
          tasks: [],
        }],
      }],
    };
    answers = () => tree;
    const { data, text } = await read<typeof tree>(paths.tree);
    expect(text).toBe(JSON.stringify(tree));
    const v = data.ventures[0] as unknown as Record<string, unknown> & typeof tree.ventures[0];
    expect(v["name"]).toBe("Venture name");
    expect(v["description"]).toBe("About it");
    expect(v["monogram"]).toBe("VN");
    expect(v.states[0]).toMatchObject({ name: "Doing", kind: "active" });
    expect(v.stages[0]).toMatchObject({ name: "Launch" });
    expect(v.projects[0]).toMatchObject({ name: "Project name" });
    expect(v.projects[0]?.milestones[0]).toMatchObject({ name: "Milestone name" });
    expect(v.tasks[0]).toMatchObject({ title: "Task title", body: "Task body", checklist: [{ text: "check", done: false }] });
    expect(v.tasks[0]?.blocker).toMatchObject({ reason: "Waiting on tax", person: "Sam" });
  });

  it("opens today, lists, the overview, the date filters, saved filters and the archive", async () => {
    const t = await stored("tasks", { id: "t1", title: "Today task", body: null });
    answers = (url) => {
      if (url.startsWith("/api/today")) return { on: "2026-01-01", tasks: [{ ...t, blocker: null }] };
      if (url.startsWith("/api/filters/dates")) return { on: "2026-01-01", before: [t], week: [t] };
      if (url.startsWith("/api/filters")) return { filters: [] };
      return {};
    };
    expect(((await read<{ tasks: { title: string }[] }>(paths.today)).data).tasks[0]?.title).toBe("Today task");
    const dates = (await read<{ before: { title: string }[]; week: { title: string }[] }>(paths.dateFilters)).data;
    expect(dates.before[0]?.title).toBe("Today task");
    expect(dates.week[0]?.title).toBe("Today task");

    const filters = { filters: [await stored("savedFilters", { id: "f1", name: "Saved", query: "q words", position: 0 })] };
    answers = () => filters;
    expect(((await read<{ filters: { name: string; query: string }[] }>(paths.filters)).data).filters[0]).toMatchObject({ name: "Saved", query: "q words" });

    const overview = { ventures: [await stored("ventures", { id: "v1", name: "Over", description: "View" })], archivedVentures: 0 };
    answers = () => overview;
    expect(((await read<{ ventures: { name: string; description: string }[] }>(paths.overview)).data).ventures[0]).toMatchObject({ name: "Over", description: "View" });

    const archived = { items: [
      { kind: "tasks", id: "t9", label: (await stored("tasks", { id: "t9", title: "Old task" })).title, archivedAt: "x" },
      { kind: "links", id: "l9", label: (await stored("links", { id: "l9", url: "https://a.example" })).url, archivedAt: "x" },
      { kind: "notes", id: "n9", label: "Locked", archivedAt: "x" },
    ] };
    answers = () => archived;
    const items = (await read<typeof archived>(paths.archived)).data.items;
    expect(items.map((i) => i.label)).toEqual(["Old task", "https://a.example", "Locked"]);
  });

  it("sorts tags by name on this device and opens one record by id", async () => {
    const tags = [
      await stored("tags", { id: "a", name: "zebra" }),
      await stored("tags", { id: "b", name: "apple" }),
      await stored("tags", { id: "c", name: "mango" }),
    ];
    answers = () => tags;
    expect((await read<{ name: string }[]>(paths.list("tags"))).data.map((x) => x.name)).toEqual(["apple", "mango", "zebra"]);
    answers = () => tags[0];
    expect((await read<{ name: string }>("/api/tags/a")).data.name).toBe("zebra");
  });

  it("opens the level names and default stages in settings", async () => {
    const row = await stored("settings", {
      levelSpace: "Realm", levelProject: "Quest",
      defaultStages: JSON.stringify([{ name: "Idea", kind: "open" }]),
    });
    answers = () => ({
      levelNames: { space: row.levelSpace, project: row.levelProject, milestone: "Milestone", task: "Task" },
      defaultStages: row.defaultStages,
      encryption: "on",
    });
    const { data } = await read<{ levelNames: Record<string, string>; defaultStages: unknown; encryption: string }>(paths.appearance);
    expect(data.levelNames).toEqual({ space: "Realm", project: "Quest", milestone: "Milestone", task: "Task" });
    expect(data.defaultStages).toEqual([{ name: "Idea", kind: "open" }]);
    expect(data.encryption).toBe("on");
  });

  it("leaves the export sealed", async () => {
    const file = { tables: { task: [{ id: "t1", title: (await stored("tasks", { id: "t1", title: "In file" })).title }] } };
    answers = () => file;
    expect((await read(paths.export)).data).toEqual(file);
  });

  it("shows names as Locked and leaves lockable fields to their own screen when there is no key", async () => {
    const project = await stored("projects", { id: "p1", name: "Hidden name", description: "Hidden brief" });
    const task = await stored("tasks", { id: "t1", title: "Hidden title", checklist: [{ text: "hidden step", done: false }] });
    answers = () => ({ ventures: [{ id: "v1", name: "Plain venture", states: [], stages: [], tasks: [task], projects: [{ ...project, milestones: [], tasks: [] }] }] });
    setKeySource(null);
    const tree = (await read<{ ventures: { name: string; tasks: { title: string; checklist: { text: string }[] }[]; projects: { name: string; description: string }[] }[] }>(paths.tree)).data;
    const v = tree.ventures[0];
    expect(v?.name).toBe("Plain venture");
    expect(v?.projects[0]?.name).toBe(LOCKED_WORD);
    expect(v?.tasks[0]?.title).toBe(LOCKED_WORD);
    // The brief is a lockable field: its envelope goes on to the screen that draws a locked field.
    expect(v?.projects[0]?.description).toMatch(/^v1\./);
    expect(v?.tasks[0]?.checklist[0]?.text).toMatch(/^v1\./);
  });

  it("shows Locked when the key on this device is another account key", async () => {
    const tag = await stored("tags", { id: "a", name: "foreign" }, other);
    answers = () => [tag];
    expect((await read<{ name: string }[]>(paths.list("tags"))).data[0]?.name).toBe(LOCKED_WORD);
  });

  it("opens again once the state or the key changes, since the body is the same", async () => {
    const tags = [await stored("tags", { id: "a", name: "kept" })];
    answers = () => tags;
    setKeySource(null);
    expect((await read<{ name: string }[]>(paths.list("tags"))).data[0]?.name).toBe(LOCKED_WORD);
    setKeySource(async () => held);
    expect((await read<{ name: string }[]>(paths.list("tags"))).data[0]?.name).toBe("kept");
  });
});

describe("where the state comes from", () => {
  it("is set from /api/encryption and remembered for a start with no connection", async () => {
    forgetSealed();
    const doFetch = (async () => new Response(JSON.stringify({ state: "on", unsealed: 0, sealed: 3 }), { status: 200 })) as unknown as typeof fetch;
    expect(await refreshEncryption(doFetch)).toBe("on");
    const failing = (async () => { throw new TypeError("Failed to fetch"); }) as unknown as typeof fetch;
    expect(await refreshEncryption(failing)).toBe("on");
    expect(await sealOutgoing("/api/tags", { id: "x", name: "n" })).not.toEqual({ id: "x", name: "n" });
  });

  it("seals nothing while the switch is off or still turning on", async () => {
    setEncryptionState("turning_on");
    expect(await sealOutgoing("/api/tags", { name: "n" })).toEqual({ name: "n" });
    setEncryptionState("off");
    expect(await sealOutgoing("/api/tags", { name: "n" })).toEqual({ name: "n" });
  });
});

describe("finishing a repeating task", () => {
  it("opens the next task's title under the finished id and seals it to its own", async () => {
    // The Worker copies the finished task's envelope, which is bound to the finished id.
    const copied = (await stored("tasks", { id: "old", title: "Water the plants" })).title;
    answers = (url, init) => {
      if (init.method === "PATCH" && url === "/api/tasks/old") {
        return { id: "old", title: copied, spawned: { id: "new", title: copied, checklist: [] } };
      }
      return JSON.parse(String(init.body));
    };
    const done = await api.update("tasks", "old", { stateId: "finished" });
    expect((done as { spawned?: { title: string } }).spawned?.title).toBe("Water the plants");
    const second = sent[1];
    expect(second?.method).toBe("PATCH");
    expect(second?.url).toBe("/api/tasks/new");
    const title = (JSON.parse(String(second?.body)) as { title: string }).title;
    expect(title).not.toContain("Water the plants");
    expect(await open(held.fieldKey, title, { record: "new", field: "title", keyRef: REF })).toBe("Water the plants");
  });

  it("sends nothing more for a task that spawned none", async () => {
    answers = () => ({ id: "old", title: "x" });
    await api.update("tasks", "old", { position: 1 });
    expect(sent).toHaveLength(1);
  });
});

describe("making a space while on", () => {
  it("seals the shipped state and stage names, brings the stages to the person's own list, and sends no plain text", async () => {
    const own = (await stored("settings", {
      defaultStages: JSON.stringify([{ name: "Seedling zebra", kind: "early" }, { name: "Growing zebra", kind: "active" }]),
    })).defaultStages;
    answers = (url, init) => {
      if (url === "/api/appearance") return { levelNames: {}, defaultStages: own, encryption: "on" };
      if (url === "/api/states?venture=v-new") return [{ id: "s1", name: "To do", kind: "open" }, { id: "s2", name: "Finished", kind: "finished" }];
      if (url === "/api/stages?venture=v-new") return [{ id: "g1", name: "Idea", kind: "early" }];
      if (init.method === "POST" && url === "/api/ventures") return { id: "v-new", name: "Garden" };
      return JSON.parse(String(init.body ?? "{}"));
    };
    await api.create("ventures", { id: "v-new", name: "Plot" });
    const writes = sent.filter((s) => s.method !== "GET");
    // The first is the space itself; the rest seal what the Worker made, each name bound to its own record.
    expect(writes.map((s) => `${s.method} ${s.url}`)).toEqual([
      "POST /api/ventures", "PATCH /api/states/s1", "PATCH /api/states/s2", "PATCH /api/stages/g1", "POST /api/stages",
    ]);
    const named = async (at: number, record: string): Promise<string> => {
      const body = JSON.parse(String(writes[at]?.body)) as { name: string; id?: string };
      return open(held.fieldKey, body.name, { record: record === "" ? String(body.id) : record, field: "name", keyRef: REF });
    };
    expect(await named(1, "s1")).toBe("To do");
    expect(await named(2, "s2")).toBe("Finished");
    expect(await named(3, "g1")).toBe("Seedling zebra");
    expect(JSON.parse(String(writes[3]?.body)).kind).toBe("early");
    expect(await named(4, "")).toBe("Growing zebra");
    expect(JSON.parse(String(writes[4]?.body)).kind).toBe("active");
    for (const w of writes.slice(1)) {
      expect(w.body).not.toContain("To do");
      expect(w.body).not.toContain("zebra");
    }
  });

  it("does nothing more when the account is off, or when the write was kept for later", async () => {
    forgetSealed();
    answers = () => ({ id: "v1", name: "Plot" });
    await api.create("ventures", { id: "v1", name: "Plot" });
    expect(sent).toHaveLength(1);
    setEncryptionState("on");
    sent.length = 0;
    down = true;
    await api.create("ventures", { id: "v2", name: "Plot" });
    expect(sent.every((s) => s.method === "POST")).toBe(true);
  });
});
