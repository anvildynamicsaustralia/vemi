import {
  keysFrom, lockBinding, makeAccountKey, makeRecoveryKey, open, recoveryWrappingKey, reseal, seal, toBase64Url, unwrapKey, wrapKey,
} from "@vemi/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { accountIdentity } from "./accountIdentity.js";
import { createApp } from "./app.js";
import { hashPassword } from "./password.js";
import { openStore } from "./store.js";
import { testDb, type TestDb } from "./testing/d1.js";

/** Sealed fields on the server, through `createApp` and a real D1. The Worker only ever holds the envelope. */

const ORIGIN = "https://vemi.example.workers.dev";
const PASSWORD = "correct horse battery";
const START = new Date("2026-11-19T02:00:00Z");

let t: TestDb;
beforeAll(async () => {
  t = await testDb();
});
afterAll(() => t.dispose());

type Json = Record<string, any>;

function world() {
  const clock = () => START;
  const copyOwner = `copy-owner-${crypto.randomUUID()}`;
  const store = openStore({ DB: t.db }, clock);
  const identity = accountIdentity({
    store, now: clock, origin: ORIGIN, owner: copyOwner, operatorEmail: `op-${crypto.randomUUID()}@example.com`, sessionSecret: "session-secret",
    google: null, fetch: (async () => { throw new Error("no network"); }) as typeof fetch,
  });
  const app = createApp({
    store, identity, now: clock, origin: ORIGIN, timeZone: "Australia/Sydney", copyOwner,
    live: { publish: async () => {}, connect: async () => new Response("connected") },
  });
  let devices = 0;
  function person() {
    const jar = new Map<string, string>();
    const ip = `10.7.${++devices}.${Math.floor(Math.random() * 250)}`;
    const send = async (method: string, path: string, body?: unknown): Promise<{ status: number; json: Json; text: string }> => {
      const response = await app(new Request(`${ORIGIN}${path}`, {
        method,
        headers: {
          origin: ORIGIN, "cf-connecting-ip": ip,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
          ...(jar.size > 0 ? { cookie: [...jar].map(([k, v]) => `${k}=${v}`).join("; ") } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      }), () => {});
      for (const line of response.headers.getSetCookie()) {
        const [pair = ""] = line.split(";");
        const eq = pair.indexOf("=");
        const value = pair.slice(eq + 1);
        if (/Max-Age=0/i.test(line) || value === "") jar.delete(pair.slice(0, eq));
        else jar.set(pair.slice(0, eq), value);
      }
      const text = await response.text();
      return { status: response.status, json: (text === "" ? {} : JSON.parse(text)) as Json, text };
    };
    return { send };
  }
  async function signedIn() {
    const id = `acct-${crypto.randomUUID()}`;
    const email = `p-${crypto.randomUUID()}@example.com`;
    expect(await store.createAccount({ id, email, passwordHash: await hashPassword(PASSWORD), googleSub: null, confirmed: true })).toBe(true);
    const p = person();
    expect((await p.send("POST", "/auth/sign-in", { email, password: PASSWORD })).status).toBe(200);
    return { ...p, id };
  }
  return { store, signedIn, person };
}

const b64 = (n: number) => toBase64Url(crypto.getRandomValues(new Uint8Array(n)));
const wrapId = () => `w${crypto.randomUUID().replaceAll("-", "")}`;

/** A person with one account key, and a space, a project, a task and a note locked with it. */
async function locked(w: ReturnType<typeof world>) {
  const p = await w.signedIn();
  const accountKey = makeAccountKey();
  const { fieldKey, keyRef, keyCheck } = await keysFrom(accountKey);
  const recoveryBytes = makeRecoveryKey();
  const wrapped = await wrapKey(await recoveryWrappingKey(recoveryBytes), accountKey, "recovery", keyRef);
  const recoveryRow = { id: wrapId(), kind: "recovery", label: "Recovery key", wrapped };
  expect((await p.send("POST", "/api/keys", { keyRef, keyCheck, wraps: [recoveryRow] })).status).toBe(200);

  const space = (await p.send("POST", "/api/ventures", { name: "Locked space" })).json;
  const projectId = crypto.randomUUID();
  const taskId = crypto.randomUUID();
  const noteId = crypto.randomUUID();
  const secret = { brief: "tell nobody about the zebrafinch plan", body: "task body with quokka", note: "note about the wombat" };
  const brief = await seal(fieldKey, keyRef, secret.brief, lockBinding("projects", projectId, "whoFor"));
  const body = await seal(fieldKey, keyRef, secret.body, lockBinding("tasks", taskId, "body"));
  const note = await seal(fieldKey, keyRef, secret.note, lockBinding("notes", noteId, "body"));
  const project = await p.send("POST", "/api/projects", { id: projectId, ventureId: space.id, name: "Shed", whoFor: brief });
  expect(project.status, project.text).toBe(201);
  const task = await p.send("POST", "/api/tasks", { id: taskId, ventureId: space.id, projectId, title: "Mend the gate", body });
  expect(task.status, task.text).toBe(201);
  const made = await p.send("POST", "/api/notes", { id: noteId, projectId, body: note });
  expect(made.status, made.text).toBe(201);
  return { p, accountKey, fieldKey, keyRef, keyCheck, recoveryBytes, space: space.id as string, projectId, taskId, noteId, brief, body, note, secret };
}

describe("restore", () => {
  it("answers which sealed fields moved, and resealing to the new id opens each", async () => {
    const w = world();
    const a = await locked(w);
    const doc = (await a.p.send("GET", "/api/export")).json;
    const b = await w.signedIn();

    const preview = await b.send("POST", "/api/restore", { document: doc });
    expect(preview.json).toMatchObject({ restored: false, confirm: "replace", locked: 3 });

    const done = await b.send("POST", "/api/restore", { document: doc, confirm: "replace" });
    expect(done.status, done.text).toBe(200);
    const list = done.json.locked as { kind: string; field: string; from: string; to: string }[];
    expect(list).toHaveLength(3);
    const by = (kind: string) => list.find((x) => x.kind === kind);
    expect(by("projects")).toMatchObject({ field: "whoFor", from: a.projectId });
    expect(by("tasks")).toMatchObject({ field: "body", from: a.taskId });
    expect(by("notes")).toMatchObject({ field: "body", from: a.noteId });
    for (const x of list) expect(x.to).not.toBe(x.from);

    // The file's envelope is bound to the old id and does not open at the new one until it is resealed.
    const restored = (await b.send("GET", "/api/locked")).json as Json[];
    expect(restored).toHaveLength(3);
    const task = restored.find((r) => r.kind === "tasks") as Json;
    await expect(open(a.fieldKey, task.value, lockBinding("tasks", task.id, "body"))).rejects.toThrow();
    const to = by("tasks")?.to as string;
    const moved = await reseal(a.fieldKey, task.value, lockBinding("tasks", a.taskId, "body"), lockBinding("tasks", to, "body"));
    expect(await open(a.fieldKey, moved, lockBinding("tasks", to, "body"))).toBe(a.secret.body);
    expect((await b.send("PATCH", `/api/tasks/${to}`, { body: moved })).status).toBe(200);

    const brief = by("projects");
    const mine = restored.find((r) => r.kind === "projects") as Json;
    const briefMoved = await reseal(a.fieldKey, mine.value, lockBinding("projects", a.projectId, "whoFor"), lockBinding("projects", brief?.to as string, "whoFor"));
    expect(await open(a.fieldKey, briefMoved, lockBinding("projects", brief?.to as string, "whoFor"))).toBe(a.secret.brief);
    const noteRow = restored.find((r) => r.kind === "notes") as Json;
    const noteMoved = await reseal(a.fieldKey, noteRow.value, lockBinding("notes", a.noteId, "body"), lockBinding("notes", by("notes")?.to as string, "body"));
    expect(await open(a.fieldKey, noteMoved, lockBinding("notes", by("notes")?.to as string, "body"))).toBe(a.secret.note);
  });

  it("keeps the key rows, which still unwrap", async () => {
    const w = world();
    const a = await locked(w);
    const doc = (await a.p.send("GET", "/api/export")).json;
    const b = await w.signedIn();
    expect((await b.send("POST", "/api/restore", { document: doc, confirm: "replace" })).status).toBe(200);
    const keys = (await b.send("GET", "/api/keys")).json;
    expect(keys.keyRef).toBe(a.keyRef);
    const row = (keys.wraps as Json[]).find((r) => r.kind === "recovery") as Json;
    expect(await unwrapKey(await recoveryWrappingKey(a.recoveryBytes), row.wrapped, "recovery", keys.keyRef)).toEqual(a.accountKey);
  });

  it("answers no locked fields for a file without any", async () => {
    const w = world();
    const p = await w.signedIn();
    const doc = (await p.send("GET", "/api/export")).json;
    expect((await p.send("POST", "/api/restore", { document: doc })).json.locked).toBe(0);
    expect((await p.send("POST", "/api/restore", { document: doc, confirm: "replace" })).json.locked).toEqual([]);
  });
});

describe("what the server keeps", () => {
  it("holds only the envelope in each row", async () => {
    const w = world();
    const a = await locked(w);
    const read = async (sql: string, id: string) => (await t.db.prepare(sql).bind(id).first<Json>()) as Json;
    const project = await read("SELECT * FROM project WHERE id = ?", a.projectId);
    const task = await read("SELECT * FROM task WHERE id = ?", a.taskId);
    const note = await read("SELECT * FROM note WHERE id = ?", a.noteId);
    expect(project.who_for).toBe(a.brief);
    expect(task.body).toBe(a.body);
    expect(note.body).toBe(a.note);
    for (const [row, plain] of [[project, a.secret.brief], [task, a.secret.body], [note, a.secret.note]] as const) {
      expect(JSON.stringify(row)).not.toContain(plain);
      for (const word of plain.split(" ").filter((x) => x.length > 4)) expect(JSON.stringify(row)).not.toContain(word);
    }
  });

  it("refuses plain text over the plain limit and takes an envelope over it", async () => {
    const w = world();
    const a = await locked(w);
    expect((await a.p.send("PATCH", `/api/notes/${a.noteId}`, { body: "x".repeat(4001) })).status).toBe(400);
    const long = await seal(a.fieldKey, a.keyRef, "é".repeat(4000), lockBinding("notes", a.noteId, "body"));
    expect(long.length).toBeGreaterThan(4000);
    expect((await a.p.send("PATCH", `/api/notes/${a.noteId}`, { body: long })).status).toBe(200);
  });

  it("never matches or lists a sealed value in search, and the archive says Locked", async () => {
    const w = world();
    const a = await locked(w);
    const search = async (q: string) => (await a.p.send("GET", `/api/search?q=${encodeURIComponent(q)}`)).json.results as Json[];
    const part = (a.note.split(".")[3] as string).slice(2, 12);
    expect(await search(part)).toEqual([]);
    expect(await search("v1.")).toEqual([]);
    expect(await search(a.keyRef)).toEqual([]);
    expect(await search("Mend the gate")).toHaveLength(1);
    for (const q of ["wombat", "quokka", "zebrafinch"]) expect(await search(q)).toEqual([]);
    expect((await a.p.send("GET", "/api/search?q=Shed")).text).not.toContain(a.brief);

    expect((await a.p.send("POST", `/api/notes/${a.noteId}/archive`, {})).status).toBeLessThan(300);
    const archived = (await a.p.send("GET", "/api/archived")).json.items as Json[];
    expect(archived.find((x) => x.id === a.noteId)).toMatchObject({ kind: "notes", label: "Locked" });
  });

  it("plain text that only starts like an envelope is still searched", async () => {
    const w = world();
    const p = await w.signedIn();
    const space = (await p.send("POST", "/api/ventures", { name: "Plain" })).json;
    await p.send("POST", "/api/notes", { ventureId: space.id, body: "v1.2 beta of the gate" });
    expect(((await p.send("GET", "/api/search?q=beta")).json.results as Json[]).some((r) => r.kind === "note")).toBe(true);
  });
});

describe("GET /api/locked", () => {
  it("answers 401 signed out", async () => {
    const w = world();
    expect((await w.person().send("GET", "/api/locked")).status).toBe(401);
  });

  it("answers the owner's live sealed fields and no one else's", async () => {
    const w = world();
    const a = await locked(w);
    const other = await locked(w);
    const mine = (await a.p.send("GET", "/api/locked")).json as Json[];
    expect(mine).toHaveLength(3);
    expect(mine).toContainEqual({
      kind: "projects", id: a.projectId, field: "whoFor", value: a.brief, ventureId: a.space, projectId: a.projectId, taskId: null,
    });
    expect(mine).toContainEqual({
      kind: "tasks", id: a.taskId, field: "body", value: a.body, ventureId: a.space, projectId: a.projectId, taskId: a.taskId,
    });
    expect(mine).toContainEqual({
      kind: "notes", id: a.noteId, field: "body", value: a.note, ventureId: a.space, projectId: a.projectId, taskId: null,
    });
    expect(JSON.stringify(mine)).not.toContain(other.taskId);

    expect((await a.p.send("POST", `/api/notes/${a.noteId}/archive`, {})).status).toBeLessThan(300);
    expect(((await a.p.send("GET", "/api/locked")).json as Json[]).map((r) => r.kind).sort()).toEqual(["projects", "tasks"]);
  });

  it("leaves out plain text, including text that starts like an envelope", async () => {
    const w = world();
    const p = await w.signedIn();
    const space = (await p.send("POST", "/api/ventures", { name: "Plain" })).json;
    await p.send("POST", "/api/notes", { ventureId: space.id, body: "v1.2 beta of the gate" });
    await p.send("POST", "/api/notes", { ventureId: space.id, body: `v1.${b64(8)}.${b64(12)}.${b64(24)} with words after` });
    expect((await p.send("GET", "/api/locked")).json).toEqual([]);
  });
});
