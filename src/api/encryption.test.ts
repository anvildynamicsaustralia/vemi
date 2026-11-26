import {
  ENCRYPTED_FIELDS, LOCKABLE, envelopeLimit, isEnvelopeShape, keysFrom, makeAccountKey, open, openRecord, seal, sealRecord, toBase64Url, type EncryptedKind,
} from "@vemi/shared";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { accountIdentity } from "./accountIdentity.js";
import { createApp } from "./app.js";
import { hashPassword } from "./password.js";
import { openStore } from "./store.js";
import { testDb, type TestDb } from "./testing/d1.js";

/**
 * Full encryption on the server, through `createApp` and a real D1. The server only counts,
 * stores and refuses; the sealing here is what a device does, with the pure module.
 */

const ORIGIN = "https://vemi.example.workers.dev";
const PASSWORD = "correct horse battery";
const START = new Date("2026-11-19T02:00:00Z");
const MESSAGE = "This VEMI is fully encrypted. Update VEMI and try again.";

// Every test signs people in and writes through the real routes, and the bulk one moves 5,000 rows.
vi.setConfig({ testTimeout: 120_000 });

let t: TestDb;
beforeAll(async () => {
  t = await testDb();
});
afterAll(() => t.dispose());

type Json = Record<string, any>;

function world(now: () => Date = () => START, db: D1Database = t.db) {
  const copyOwner = `copy-owner-${crypto.randomUUID()}`;
  const store = openStore({ DB: db }, now);
  const identity = accountIdentity({
    store, now, origin: ORIGIN, owner: copyOwner, operatorEmail: `op-${crypto.randomUUID()}@example.com`, sessionSecret: "session-secret",
    google: null, fetch: (async () => { throw new Error("no network"); }) as typeof fetch,
  });
  const app = createApp({
    store, identity, now, origin: ORIGIN, timeZone: "Australia/Sydney", copyOwner,
    live: { publish: async () => {}, connect: async () => new Response("connected") },
  });
  let devices = 0;
  function person() {
    const jar = new Map<string, string>();
    const ip = `10.9.${++devices}.${Math.floor(Math.random() * 250)}`;
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

type Person = Awaited<ReturnType<ReturnType<typeof world>["signedIn"]>>;
interface Key { readonly fieldKey: CryptoKey; readonly keyRef: string }
const newKey = async (): Promise<Key> => {
  const { fieldKey, keyRef } = await keysFrom(makeAccountKey());
  return { fieldKey, keyRef };
};

// -- what a device does: read, seal or open, and send in batches of 50 ---------------------

const TABLE_KIND: Readonly<Record<string, EncryptedKind>> = {
  venture: "ventures", state: "states", stage: "stages", project: "projects", milestone: "milestones", task: "tasks",
  blocker: "blockers", note: "notes", decision: "decisions", risk: "risks", link: "links", tag: "tags", saved_filter: "savedFilters",
};
const snake = (field: string): string => field.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

interface Rec { readonly kind: string; readonly id: string; readonly fields: Json }

/** The records a device would send to move every typed cell the way `direction` says. Cells already there are left out. */
async function records(p: Person, key: Key, direction: "seal" | "open"): Promise<Rec[]> {
  const walk = direction === "seal" ? sealRecord : openRecord;
  const doc = (await p.send("GET", "/api/export")).json;
  const out: Rec[] = [];
  const push = (kind: string, id: string, was: Json, now: Json): void => {
    const fields: Json = {};
    for (const [field, value] of Object.entries(now)) {
      if (field !== "id" && JSON.stringify(value) !== JSON.stringify(was[field])) fields[field] = value;
    }
    if (Object.keys(fields).length > 0) out.push({ kind, id, fields });
  };
  for (const [table, kind] of Object.entries(TABLE_KIND)) {
    for (const row of (doc.tables[table] ?? []) as Json[]) {
      const src: Json = { id: row.id };
      for (const field of ENCRYPTED_FIELDS[kind] as readonly string[]) {
        const v = row[snake(field)];
        if (typeof v === "string" && v !== "") src[field] = v;
      }
      if (kind === "tasks") {
        const items = JSON.parse(row.checklist) as unknown[];
        if (items.length > 0) src.checklist = items;
      }
      const done = await walk(key.fieldKey, key.keyRef, kind, src);
      expect(done.failed).toEqual([]);
      push(kind, row.id, src, done.row as Json);
    }
  }
  // The settings: the four level names and the starting stages, the stages as the one text they are sealed as.
  const settings = (await p.send("GET", "/api/appearance")).json;
  const stages = typeof settings.defaultStages === "string" ? settings.defaultStages
    : settings.defaultStages === null ? undefined : JSON.stringify(settings.defaultStages);
  const levels: Json = { id: p.id, levelSpace: settings.levelNames.space, levelProject: settings.levelNames.project,
    levelMilestone: settings.levelNames.milestone, levelTask: settings.levelNames.task };
  if (stages !== undefined) levels.defaultStages = stages;
  const settled = await walk(key.fieldKey, key.keyRef, "settings", levels);
  expect(settled.failed).toEqual([]);
  push("settings", p.id, levels, settled.row as Json);
  // A connector change keeps what a record was, as JSON text: that text is the one cell.
  for (const row of (doc.tables.connector_change ?? []) as Json[]) {
    if (typeof row.before !== "string") continue;
    const bound = { record: row.id, field: "before" };
    const now = direction === "seal"
      ? (isEnvelopeShape(row.before) ? row.before : await seal(key.fieldKey, key.keyRef, row.before, bound))
      : (isEnvelopeShape(row.before) ? await open(key.fieldKey, row.before, { ...bound, keyRef: key.keyRef }) : row.before);
    push("connector_change", row.id, { before: row.before }, { before: now });
  }
  return out;
}

/** Sends records in batches of 50. Stops after `most` batches when given. Answers how many batches went. */
async function send(p: Person, list: readonly Rec[], most = Infinity): Promise<number> {
  let sent = 0;
  for (let at = 0; at < list.length && sent < most; at += 50) {
    const res = await p.send("POST", "/api/encryption/batch", { records: list.slice(at, at + 50) });
    expect(res.status, res.text).toBe(200);
    sent++;
  }
  return sent;
}

/** Every text cell of every table, as `exportAll` reads them. */
async function everyText(db: D1Database): Promise<string[]> {
  const master = await db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND sql IS NOT NULL`).all<{ name: string }>();
  const out: string[] = [];
  for (const { name } of master.results) {
    if (!/^[a-z][a-z_0-9]*$/i.test(name) || name.startsWith("_cf")) continue;
    const rows = await db.prepare(`SELECT * FROM "${name}"`).all<Json>();
    for (const row of rows.results) for (const v of Object.values(row)) if (typeof v === "string") out.push(v.includes("Zebrafinch Studios") ? `${name}:${v}` : v);
  }
  return out;
}

/** Whether a cell holds the string. A string of a few letters could sit inside any envelope, so it must be the whole cell. */
const holds = (cells: readonly string[], s: string): boolean => (s.length < 8 ? cells.includes(s) : cells.some((c) => c.includes(s)));

const SEEDED = [
  "Zebrafinch Studios", "a study of the zebrafinch", "ZF", "Backlog zebrafinch", "Stage zebrafinch",
  "Shed zebrafinch", "brief zebrafinch", "who zebrafinch", "done zebrafinch", "open zebrafinch",
  "Gate milestone zebrafinch", "Mend the gate zebrafinch", "body zebrafinch", "step one zebrafinch", "step two zebrafinch",
  "reason zebrafinch", "person zebrafinch", "note zebrafinch", "decision zebrafinch", "decision body zebrafinch",
  "risk zebrafinch", "risk body zebrafinch", "zebrafinch.example", "label zebrafinch", "tag zebrafinch",
  "filter zebrafinch", "query zebrafinch", "Level zebrafinch", "Stage list zebrafinch", "change zebrafinch",
];

/** One of everything typed, each with a string no other part of the app holds. */
async function seed(w: ReturnType<typeof world>) {
  const p = await w.signedIn();
  const ok = (r: { status: number; json: Json; text: string }): Json => {
    expect(r.status, r.text).toBeLessThan(300);
    return r.json;
  };
  const venture = ok(await p.send("POST", "/api/ventures", { name: SEEDED[0], description: SEEDED[1] }));
  ok(await p.send("PATCH", `/api/ventures/${venture.id}`, { monogram: SEEDED[2] }));
  const own = (await p.send("GET", "/api/export")).json.tables;
  const states = (own.state as Json[]).filter((x) => x.venture_id === venture.id);
  ok(await p.send("PATCH", `/api/states/${states[0]?.id}`, { name: SEEDED[3] }));
  const stages = (own.stage as Json[]).filter((x) => x.venture_id === venture.id);
  ok(await p.send("PATCH", `/api/stages/${stages[0]?.id}`, { name: SEEDED[4] }));
  const project = ok(await p.send("POST", "/api/projects", {
    ventureId: venture.id, name: SEEDED[5], description: SEEDED[6], whoFor: SEEDED[7], doneLooks: SEEDED[8], openQuestions: SEEDED[9],
  }));
  const milestone = ok(await p.send("POST", "/api/milestones", { projectId: project.id, name: SEEDED[10] }));
  const task = ok(await p.send("POST", "/api/tasks", {
    ventureId: venture.id, projectId: project.id, title: SEEDED[11], body: SEEDED[12],
    checklist: [{ text: SEEDED[13], done: false }, { text: SEEDED[14], done: true }],
  }));
  const blocker = ok(await p.send("POST", "/api/blockers", { taskId: task.id, reason: SEEDED[15], person: SEEDED[16] }));
  const note = ok(await p.send("POST", "/api/notes", { projectId: project.id, body: SEEDED[17] }));
  const decision = ok(await p.send("POST", "/api/decisions", { ventureId: venture.id, title: SEEDED[18], body: SEEDED[19] }));
  const risk = ok(await p.send("POST", "/api/risks", { ventureId: venture.id, title: SEEDED[20], body: SEEDED[21] }));
  const link = ok(await p.send("POST", "/api/links", { projectId: project.id, url: `https://${SEEDED[22]}/plan`, label: SEEDED[23] }));
  const tag = ok(await p.send("POST", "/api/tags", { name: SEEDED[24] }));
  const filter = ok(await p.send("POST", "/api/filters", { name: SEEDED[25], query: SEEDED[26] }));
  ok(await p.send("PATCH", "/api/appearance", {
    levelNames: { space: SEEDED[27], project: "Project", milestone: "Milestone", task: "Task" },
    defaultStages: [{ name: SEEDED[28] as string, kind: "early" }],
  }));
  await w.store.registerClient({ id: `c-${p.id}`, name: "Claude", redirectUris: ["https://claude.example/cb"] });
  const grant = await w.store.issueGrant(p.id, { clientId: `c-${p.id}`, tokenHash: `h${p.id}`, refreshHash: `r${p.id}`, expiresAt: "2026-12-30T00:00:00.000Z" });
  await w.store.recordChange(p.id, { grantId: grant.id, clientName: "Claude", tool: "update_task", kind: "tasks", recordId: task.id, before: { title: SEEDED[29] } });
  return { p, venture, states, stages, project, milestone, task, blocker, note, decision, risk, link, tag, filter };
}

/** Turn on and seal everything. */
async function turnOn(p: Person, key: Key): Promise<void> {
  expect((await p.send("POST", "/api/encryption/start", { to: "on" })).status).toBe(200);
  await send(p, await records(p, key, "seal"));
  const done = await p.send("POST", "/api/encryption/finish");
  expect(done.status, done.text).toBe(200);
  expect(done.json.state).toBe("on");
}

describe("state and routes", () => {
  it("starts off, is in appearance, and every route answers 401 signed out", async () => {
    const w = world();
    const p = await w.signedIn();
    expect((await p.send("GET", "/api/encryption")).json).toMatchObject({ state: "off", sealed: 0 });
    expect((await p.send("GET", "/api/appearance")).json.encryption).toBe("off");
    const out = w.person();
    expect((await out.send("GET", "/api/encryption")).status).toBe(401);
    for (const [route, body] of [["start", { to: "on" }], ["batch", { records: [] }], ["finish", {}]] as const) {
      expect((await out.send("POST", `/api/encryption/${route}`, body)).status).toBe(401);
    }
  });

  it("starts either way once, and refuses a second start, the other way while running, and the state it is already in", async () => {
    const w = world();
    const p = await w.signedIn();
    expect((await p.send("POST", "/api/encryption/start", { to: "off" })).status).toBe(409);
    expect((await p.send("POST", "/api/encryption/start", { to: "sideways" })).status).toBe(400);
    expect((await p.send("POST", "/api/encryption/start", { to: "on" })).json.state).toBe("turning_on");
    expect((await p.send("POST", "/api/encryption/start", { to: "on" })).status).toBe(409);
    expect((await p.send("POST", "/api/encryption/start", { to: "off" })).status).toBe(409);
    // An account with nothing in it has nothing left to seal, so it finishes at once.
    const early = await p.send("POST", "/api/encryption/finish");
    expect(early.status).toBe(200);
    expect(early.json.state).toBe("on");
    expect((await p.send("POST", "/api/encryption/start", { to: "on" })).status).toBe(409);
    expect((await p.send("POST", "/api/encryption/start", { to: "off" })).json.state).toBe("turning_off");
  });

  it("refuses a batch when no run is going, too many records, unknown fields and cells that are the wrong way round", async () => {
    const w = world();
    const a = await seed(w);
    const key = await newKey();
    const bound = { record: a.task.id, field: "title" };
    const sealedTitle = await seal(key.fieldKey, key.keyRef, "x", bound);
    const one = { records: [{ kind: "tasks", id: a.task.id, fields: { title: sealedTitle } }] };
    expect((await a.p.send("POST", "/api/encryption/batch", one)).status).toBe(409);

    await a.p.send("POST", "/api/encryption/start", { to: "on" });
    const many = Array.from({ length: 51 }, () => one.records[0]);
    expect((await a.p.send("POST", "/api/encryption/batch", { records: many })).status).toBe(400);
    expect((await a.p.send("POST", "/api/encryption/batch", { records: [{ kind: "tasks", id: a.task.id, fields: { dueOn: "2026-01-01" } }] })).status).toBe(400);
    expect((await a.p.send("POST", "/api/encryption/batch", { records: [{ kind: "nothing", id: a.task.id, fields: { title: sealedTitle } }] })).status).toBe(400);
    const plain = await a.p.send("POST", "/api/encryption/batch", { records: [{ kind: "tasks", id: a.task.id, fields: { title: "still plain" } }] });
    expect(plain.status).toBe(409);
    expect((await a.p.send("GET", `/api/tasks/${a.task.id}`)).json.title).toBe(SEEDED[11]);
    expect((await a.p.send("POST", "/api/encryption/batch", one)).status).toBe(200);
    expect((await a.p.send("GET", `/api/tasks/${a.task.id}`)).json.title).toBe(sealedTitle);
    // An item of a checklist is held to the same rule.
    const plainStep = await a.p.send("POST", "/api/encryption/batch", {
      records: [{ kind: "tasks", id: a.task.id, fields: { checklist: [{ text: "plain step", done: false }] } }],
    });
    expect(plainStep.status).toBe(409);
  });

  it("refuses a sealed cell while turning off", async () => {
    const w = world();
    const a = await seed(w);
    const key = await newKey();
    await turnOn(a.p, key);
    expect((await a.p.send("POST", "/api/encryption/start", { to: "off" })).json.state).toBe("turning_off");
    const stored = (await a.p.send("GET", `/api/tasks/${a.task.id}`)).json.title as string;
    expect(isEnvelopeShape(stored)).toBe(true);
    const refused = await a.p.send("POST", "/api/encryption/batch", { records: [{ kind: "tasks", id: a.task.id, fields: { title: stored } }] });
    expect(refused.status).toBe(409);
    const early = await a.p.send("POST", "/api/encryption/finish");
    expect(early.status).toBe(409);
    expect(early.json.sealed).toBeGreaterThan(0);
    expect(early.json.state).toBe("turning_off");
  });

  it("does not write another owner's record, and does not say it exists", async () => {
    const w = world();
    const a = await seed(w);
    const b = await w.signedIn();
    const key = await newKey();
    await b.send("POST", "/api/encryption/start", { to: "on" });
    const theirs = await seal(key.fieldKey, key.keyRef, "x", { record: a.task.id, field: "title" });
    const res = await b.send("POST", "/api/encryption/batch", { records: [{ kind: "tasks", id: a.task.id, fields: { title: theirs } }] });
    expect(res.status, res.text).toBe(404);
    const missing = await b.send("POST", "/api/encryption/batch", { records: [{ kind: "tasks", id: "no-such-task-id", fields: { title: theirs } }] });
    expect(missing.status).toBe(404);
    expect(missing.json.error).toBe(res.json.error);
    expect(res.text).not.toContain(a.task.id);
    expect((await a.p.send("GET", `/api/tasks/${a.task.id}`)).json.title).toBe(SEEDED[11]);
    // The settings record is the account's own id and no other.
    const levels = await seal(key.fieldKey, key.keyRef, "L", { record: "settings", field: "levelSpace" });
    expect((await b.send("POST", "/api/encryption/batch", { records: [{ kind: "settings", id: a.p.id, fields: { levelSpace: levels } }] })).status).toBe(404);
  });
});

describe("sealing everything", () => {
  it("leaves none of the seeded strings in any table, then gives them back", async () => {
    // Its own database, so the scan holds nothing another test wrote.
    const own = await testDb();
    try {
    const w = world(() => START, own.db);
    const a = await seed(w);
    const key = await newKey();
    const before = await everyText(own.db);
    for (const s of SEEDED) expect(holds(before, s), s).toBe(true);

    expect((await a.p.send("POST", "/api/encryption/start", { to: "on" })).status).toBe(200);
    const counts = (await a.p.send("GET", "/api/encryption")).json;
    expect(counts.unsealed).toBeGreaterThan(30);
    const early = await a.p.send("POST", "/api/encryption/finish");
    expect(early.status).toBe(409);
    expect(early.json).toMatchObject({ state: "turning_on", unsealed: counts.unsealed, sealed: 0 });

    await send(a.p, await records(a.p, key, "seal"));
    expect((await a.p.send("GET", "/api/encryption")).json).toMatchObject({ state: "turning_on", unsealed: 0 });
    expect((await a.p.send("POST", "/api/encryption/finish")).json.state).toBe("on");

    const after = await everyText(own.db);
    for (const s of SEEDED) expect(holds(after, s), s).toBe(false);
    // What is held opens, bound to its record and field.
    const title = (await a.p.send("GET", `/api/tasks/${a.task.id}`)).json.title as string;
    expect(await open(key.fieldKey, title, { record: a.task.id, field: "title", keyRef: key.keyRef })).toBe(SEEDED[11]);
    expect((await a.p.send("GET", "/api/appearance")).json.encryption).toBe("on");

    // And back.
    expect((await a.p.send("POST", "/api/encryption/start", { to: "off" })).status).toBe(200);
    await send(a.p, await records(a.p, key, "open"));
    expect((await a.p.send("POST", "/api/encryption/finish")).json.state).toBe("off");
    const again = await everyText(own.db);
    for (const s of SEEDED) expect(holds(again, s), s).toBe(true);
    expect((await a.p.send("GET", `/api/tasks/${a.task.id}`)).json.title).toBe(SEEDED[11]);
    expect((await a.p.send("GET", `/api/tasks/${a.task.id}`)).json.checklist).toEqual([
      { text: SEEDED[13], done: false }, { text: SEEDED[14], done: true },
    ]);
    } finally {
      await own.dispose();
    }
  });

  it("seals 5,000 tasks in batches of 50 and opens them again, resumed after a stop at batch 40", async () => {
    const w = world();
    const p = await w.signedIn();
    const key = await newKey();
    const venture = (await p.send("POST", "/api/ventures", { name: "Bulk" })).json;
    // Seeded in one statement: the route would take minutes to make 5,000 tasks one at a time.
    const made = Array.from({ length: 5000 }, (_, n) => ({ id: `bulk-${n}-${p.id}`, title: `Bulk task ${n}`, n }));
    await t.db.prepare(
      `INSERT INTO task (id, owner, venture_id, title, position, created_at, updated_at)
       SELECT json_extract(value, '$.id'), ?1, ?2, json_extract(value, '$.title'), json_extract(value, '$.n'), ?3, ?3 FROM json_each(?4)`,
    ).bind(p.id, venture.id, START.toISOString(), JSON.stringify(made)).run();
    expect((await p.send("POST", "/api/encryption/start", { to: "on" })).status).toBe(200);
    const total = (await p.send("GET", "/api/encryption")).json.unsealed as number;
    expect(total).toBeGreaterThanOrEqual(5001);

    const first = await records(p, key, "seal");
    expect(await send(p, first, 40)).toBe(40);
    const stopped = await p.send("GET", "/api/encryption");
    expect(stopped.json).toMatchObject({ state: "turning_on", unsealed: total - 2000, sealed: 2000 });
    const refused = await p.send("POST", "/api/encryption/finish");
    expect(refused.status).toBe(409);
    expect(refused.json).toMatchObject({ unsealed: total - 2000, sealed: 2000 });

    // A new run reads what the server still holds and sends only that.
    const rest = await records(p, key, "seal");
    expect(rest).toHaveLength(first.length - 2000);
    await send(p, rest);
    const sealed = (await p.send("GET", "/api/encryption")).json;
    expect(sealed.unsealed).toBe(0);
    // The four level names are sealed with the rest, so there are a few more sealed than there were plain.
    expect(sealed.sealed).toBeGreaterThanOrEqual(total);
    expect((await p.send("POST", "/api/encryption/finish")).json.state).toBe("on");

    expect((await p.send("POST", "/api/encryption/start", { to: "off" })).status).toBe(200);
    const opened = await records(p, key, "open");
    expect(await send(p, opened, 40)).toBe(40);
    expect((await p.send("POST", "/api/encryption/finish")).status).toBe(409);
    await send(p, await records(p, key, "open"));
    expect((await p.send("POST", "/api/encryption/finish")).json).toMatchObject({ state: "off", sealed: 0 });
    const row = await t.db.prepare(`SELECT title FROM task WHERE id = ?`).bind(`bulk-4999-${p.id}`).first<{ title: string }>();
    expect(row?.title).toBe("Bulk task 4999");
  }, 900_000);
});

describe("while on", () => {
  it("refuses a create or an update of a typed field that is not an envelope, for every kind", async () => {
    const w = world();
    const a = await seed(w);
    const key = await newKey();
    await turnOn(a.p, key);
    const s = async (text: string, record: string, field: string) => seal(key.fieldKey, key.keyRef, text, { record, field });
    const refuse = async (r: Promise<{ status: number; json: Json; text: string }>) => {
      const res = await r;
      expect(res.status, res.text).toBe(409);
      expect(res.json.error).toBe(MESSAGE);
    };
    const v = a.venture.id as string;
    const p = a.p;
    // Creates, plain.
    await refuse(p.send("POST", "/api/ventures", { name: "plain" }));
    await refuse(p.send("POST", "/api/states", { ventureId: v, name: "plain", kind: "not_started" }));
    await refuse(p.send("POST", "/api/stages", { ventureId: v, name: "plain", kind: "active" }));
    await refuse(p.send("POST", "/api/projects", { ventureId: v, name: "plain" }));
    await refuse(p.send("POST", "/api/milestones", { projectId: a.project.id, name: "plain" }));
    await refuse(p.send("POST", "/api/tasks", { ventureId: v, title: "plain" }));
    await refuse(p.send("POST", "/api/tasks", { ventureId: v, title: await s("t", "x", "title"), checklist: [{ text: "plain", done: false }] }));
    await refuse(p.send("POST", "/api/blockers", { taskId: a.task.id, reason: "plain" }));
    await refuse(p.send("POST", "/api/notes", { ventureId: v, body: "plain" }));
    await refuse(p.send("POST", "/api/decisions", { ventureId: v, title: "plain" }));
    await refuse(p.send("POST", "/api/risks", { ventureId: v, title: "plain" }));
    await refuse(p.send("POST", "/api/links", { ventureId: v, url: "https://plain.example" }));
    await refuse(p.send("POST", "/api/tags", { name: "plain" }));
    await refuse(p.send("POST", "/api/filters", { name: "plain", query: "plain" }));
    // Updates, plain.
    await refuse(p.send("PATCH", `/api/ventures/${v}`, { name: "plain" }));
    await refuse(p.send("PATCH", `/api/states/${a.states[0]?.id}`, { name: "plain" }));
    await refuse(p.send("PATCH", `/api/stages/${a.stages[0]?.id}`, { name: "plain" }));
    await refuse(p.send("PATCH", `/api/projects/${a.project.id}`, { description: "plain" }));
    await refuse(p.send("PATCH", `/api/milestones/${a.milestone.id}`, { name: "plain" }));
    await refuse(p.send("PATCH", `/api/tasks/${a.task.id}`, { title: "plain" }));
    await refuse(p.send("PATCH", `/api/tasks/${a.task.id}`, { checklist: [{ text: "plain", done: true }] }));
    await refuse(p.send("PATCH", `/api/blockers/${a.blocker.id}`, { reason: "plain" }));
    await refuse(p.send("PATCH", `/api/notes/${a.note.id}`, { body: "plain" }));
    await refuse(p.send("PATCH", `/api/decisions/${a.decision.id}`, { body: "plain" }));
    await refuse(p.send("PATCH", `/api/risks/${a.risk.id}`, { title: "plain" }));
    await refuse(p.send("PATCH", `/api/links/${a.link.id}`, { label: "plain" }));
    await refuse(p.send("PATCH", `/api/tags/${a.tag.id}`, { name: "plain" }));
    await refuse(p.send("PATCH", `/api/filters/${a.filter.id}`, { name: "plain" }));
    await refuse(p.send("PATCH", "/api/appearance", { levelNames: { space: "plain" } }));
    await refuse(p.send("PATCH", "/api/appearance", { defaultStages: [{ name: "plain", kind: "early" }] }));

    // Envelopes are accepted, bound to the id the client chose; plain fields that are not typed pass.
    const id = "client-task-0001";
    const made = await p.send("POST", "/api/tasks", { id, ventureId: v, title: await s("sealed title", id, "title"), dueOn: "2026-12-01" });
    expect(made.status, made.text).toBe(201);
    expect((await p.send("PATCH", `/api/tasks/${id}`, { dueOn: "2026-12-02", body: null })).status).toBe(200);
    const done = await p.send("PATCH", `/api/tasks/${id}`, { checklist: [{ text: await s("step", id, "checklist.text"), done: true }] });
    expect(done.status, done.text).toBe(200);
    const named = await s("Level", "settings", "levelSpace");
    expect((await p.send("PATCH", "/api/appearance", { levelNames: { space: named } })).json.levelNames.space).toBe(named);
    expect((await p.send("PATCH", "/api/appearance", { levelNames: { space: null }, accent: "rose" })).status).toBe(200);
    const fid = "client-filter-0001";
    const saved = await p.send("POST", "/api/filters", { id: fid, name: await s("n", fid, "name"), query: await s("q", fid, "query") });
    expect(saved.status, saved.text).toBe(201);
    expect(saved.json.id).toBe(fid);
    // The same id sent again is the same filter.
    const twice = await p.send("POST", "/api/filters", { id: fid, name: await s("n", fid, "name"), query: await s("q", fid, "query") });
    expect(twice.json.id).toBe(fid);
    expect((await p.send("GET", "/api/filters")).json.filters.filter((f: Json) => f.id === fid)).toHaveLength(1);
  });

  it("answers an empty search, and does not cut a sealed note in the archive", async () => {
    const w = world();
    const a = await seed(w);
    const key = await newKey();
    expect((await a.p.send("GET", "/api/search?q=zebrafinch")).json.results.length).toBeGreaterThan(0);
    await turnOn(a.p, key);
    expect((await a.p.send("GET", "/api/search?q=zebrafinch")).json.results).toEqual([]);
    expect((await a.p.send("GET", "/api/search?q=v1")).json.results).toEqual([]);

    const id = "client-note-0001";
    const sealed = await seal(key.fieldKey, key.keyRef, "long ".repeat(800), { record: id, field: "body" });
    expect(sealed.length).toBeGreaterThan(120);
    expect((await a.p.send("POST", "/api/notes", { id, projectId: a.project.id, body: sealed })).status).toBe(201);
    expect((await a.p.send("POST", `/api/notes/${id}/archive`)).status).toBe(200);
    const items = (await a.p.send("GET", "/api/archived")).json.items as Json[];
    expect(items.find((x) => x.id === id)?.label).toBe(sealed);
  });

  it("takes an envelope up to envelopeLimit of the plain limit and not past it", async () => {
    const w = world();
    const p = await w.signedIn();
    const key = await newKey();
    expect((await p.send("POST", "/api/encryption/start", { to: "on" })).status).toBe(200);
    const big = "😀".repeat(60);
    const id = "client-venture-0001";
    const fits = await seal(key.fieldKey, key.keyRef, big, { record: id, field: "name" });
    expect(fits.length).toBeLessThanOrEqual(envelopeLimit(120));
    expect((await p.send("POST", "/api/ventures", { id, name: fits })).status).toBe(201);
    const tooLong = `v1.${"A".repeat(11)}.${"B".repeat(16)}.${"C".repeat(envelopeLimit(120))}`;
    const res = await p.send("POST", "/api/ventures", { name: tooLong });
    expect(res.status).toBe(400);
    expect((await p.send("POST", "/api/ventures", { name: "x".repeat(121) })).status).toBe(400);
  });
});

describe("restore, export and purge", () => {
  it("restores with the map of old ids to new, and opens nothing it was not asked to", async () => {
    const w = world();
    const a = await seed(w);
    const doc = (await a.p.send("GET", "/api/export")).json;
    expect(doc.settings.encryption).toBe("off");
    const b = await w.signedIn();
    const done = await b.send("POST", "/api/restore", { document: doc, confirm: "replace" });
    expect(done.status, done.text).toBe(200);
    const ids = done.json.ids as Record<string, string>;
    expect(Object.keys(ids)).toContain(a.task.id);
    expect(ids[a.task.id]).not.toBe(a.task.id);
    expect((await b.send("GET", `/api/tasks/${ids[a.task.id]}`)).json.title).toBe(SEEDED[11]);
    expect((await b.send("GET", "/api/appearance")).json.encryption).toBe("off");
  });

  it("exports where the account is, and purges the account with it", async () => {
    const later = new Date("2026-12-20T00:00:00Z");
    let at = START;
    const w = world(() => at);
    const a = await seed(w);
    const key = await newKey();
    await turnOn(a.p, key);
    expect((await a.p.send("GET", "/api/export")).json.settings.encryption).toBe("on");
    expect((await a.p.send("POST", "/api/deletion")).status).toBe(200);
    at = later;
    expect(await w.store.purgeAccounts("nobody")).toBeGreaterThanOrEqual(1);
    const left = await t.db.prepare(`SELECT COUNT(*) AS n FROM account WHERE id = ?`).bind(a.p.id).first<{ n: number }>();
    expect(left?.n).toBe(0);
    const tasks = await t.db.prepare(`SELECT COUNT(*) AS n FROM task WHERE owner = ?`).bind(a.p.id).first<{ n: number }>();
    expect(tasks?.n).toBe(0);
  });
});

describe("finishing a repeating task while on", () => {
  it("makes a next task whose title the device seals to its own id", async () => {
    const w = world();
    const a = await seed(w);
    const key = await newKey();
    await turnOn(a.p, key);
    const id = crypto.randomUUID();
    const title = await seal(key.fieldKey, key.keyRef, "Water the plants", { record: id, field: "title" });
    const made = await a.p.send("POST", "/api/tasks", { id, ventureId: a.venture.id, title, repeat: "day", dueOn: "2026-11-19" });
    expect(made.status, made.text).toBe(201);
    const finished = (a.states as Json[]).find((s) => s.kind === "finished");
    const res = await a.p.send("PATCH", `/api/tasks/${id}`, { stateId: finished?.id });
    expect(res.status, res.text).toBe(200);
    const next = res.json.spawned as Json;
    expect(next.id).not.toBe(id);
    // The Worker can only copy the envelope, which opens under the finished id and not the new one.
    await expect(open(key.fieldKey, next.title, { record: id, field: "title", keyRef: key.keyRef })).resolves.toBe("Water the plants");
    await expect(open(key.fieldKey, next.title, { record: next.id, field: "title", keyRef: key.keyRef })).rejects.toThrow();
    // The device seals the title to the new id, and from then on it opens there.
    const resealed = await seal(key.fieldKey, key.keyRef, "Water the plants", { record: next.id, field: "title" });
    expect((await a.p.send("PATCH", `/api/tasks/${next.id}`, { title: resealed })).status).toBe(200);
    const stored = (await a.p.send("GET", `/api/tasks/${next.id}`)).json;
    await expect(open(key.fieldKey, stored.title, { record: next.id, field: "title", keyRef: key.keyRef })).resolves.toBe("Water the plants");
    expect(stored.repeat).toBe("day");
  });
});

/** Gives the account the key a device made, so the Worker knows which key ref is current. */
async function registerKey(p: Person, key: Key): Promise<void> {
  const res = await p.send("POST", "/api/keys", {
    keyRef: key.keyRef, keyCheck: toBase64Url(crypto.getRandomValues(new Uint8Array(16))),
    wraps: [{ id: `w${crypto.randomUUID().replaceAll("-", "")}`, kind: "device", label: "Chrome on Windows" }],
  });
  expect(res.status, res.text).toBe(200);
}

const isLockable = (rec: Rec, field: string): boolean =>
  ((LOCKABLE as Readonly<Record<string, readonly string[]>>)[rec.kind] ?? []).includes(field);

describe("turning off with cells a person can lock", () => {
  it("counts the account's own envelopes in lockable columns, so a stopped run resumes and finish waits for them", async () => {
    const own = await testDb();
    try {
      const w = world(() => START, own.db);
      const a = await seed(w);
      const key = await newKey();
      await registerKey(a.p, key);
      await turnOn(a.p, key);
      expect((await a.p.send("POST", "/api/encryption/start", { to: "off" })).status).toBe(200);

      // The run stops after everything but the lockable cells: a project's brief, a task body and a note.
      const all = await records(a.p, key, "open");
      const lockableOnes: Rec[] = [];
      const rest: Rec[] = [];
      for (const rec of all) {
        const held = Object.keys(rec.fields).filter((f) => isLockable(rec, f));
        const other = Object.fromEntries(Object.entries(rec.fields).filter(([f]) => !isLockable(rec, f)));
        if (held.length > 0) lockableOnes.push({ ...rec, fields: Object.fromEntries(held.map((f) => [f, rec.fields[f]])) });
        if (Object.keys(other).length > 0) rest.push({ ...rec, fields: other });
      }
      expect(lockableOnes.length).toBeGreaterThanOrEqual(3);
      await send(a.p, rest);
      const waiting = await a.p.send("GET", "/api/encryption");
      expect(waiting.json.state).toBe("turning_off");
      // Project description, who for, done looks, open questions, one task body and one note body.
      expect(waiting.json.sealed).toBe(6);
      const early = await a.p.send("POST", "/api/encryption/finish");
      expect(early.status).toBe(409);
      expect(early.json.sealed).toBe(6);

      // One note body is under another key: not this run's to open, so it does not hold the finish back.
      const foreign = `v1.${"z".repeat(11)}.${"A".repeat(16)}.${"B".repeat(40)}`;
      await own.db.prepare(`UPDATE note SET body = ? WHERE id = ?`).bind(foreign, a.note.id).run();
      expect((await a.p.send("GET", "/api/encryption")).json.sealed).toBe(5);

      await send(a.p, lockableOnes.filter((r) => r.kind !== "notes"));
      const done = await a.p.send("POST", "/api/encryption/finish");
      expect(done.status, done.text).toBe(200);
      expect(done.json.state).toBe("off");
      expect((await a.p.send("GET", `/api/tasks/${a.task.id}`)).json.body).toBe(SEEDED[12]);
      expect((await a.p.send("GET", `/api/projects/${a.project.id}`)).json.whoFor).toBe(SEEDED[7]);
    } finally {
      await own.dispose();
    }
  });
});

describe("restoring into an account that is on", () => {
  it("refuses a file that holds plain typed text, changes nothing, and takes the account's own sealed export", async () => {
    const w = world();
    const plainOwner = await seed(w);
    const plainFile = (await plainOwner.p.send("GET", "/api/export")).json;
    const a = await seed(w);
    const key = await newKey();
    await turnOn(a.p, key);
    const before = (await a.p.send("GET", "/api/export")).json;

    const refused = await a.p.send("POST", "/api/restore", { document: plainFile, confirm: "replace" });
    expect(refused.status).toBe(409);
    expect(refused.json.error).toBe(MESSAGE);
    const after = (await a.p.send("GET", "/api/export")).json;
    expect(after.tables).toEqual(before.tables);
    expect((await a.p.send("GET", "/api/encryption")).json).toMatchObject({ state: "on", unsealed: 0 });

    // Its own file, every typed cell an envelope, is taken; the account is still on with nothing plain in it.
    const own = await a.p.send("POST", "/api/restore", { document: before, confirm: "replace" });
    expect(own.status, own.text).toBe(200);
    expect((await a.p.send("GET", "/api/encryption")).json).toMatchObject({ state: "on", unsealed: 0 });
  });
});
