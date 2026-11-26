import { beforeEach, describe, expect, it } from "vitest";
import { isEnvelopeShape, open, seal } from "@vemi/shared";
import { encryptionApi } from "./encryptionApi.js";
import { WAITING, encryptionRun, type Progress } from "./encryptionRun.js";
import type { EncryptionState } from "./sealedApi.js";

const REF = "abcdefghijk";
const ACCOUNT = "account-1";
const SHIPPED = { space: "Space", project: "Project", milestone: "Milestone", task: "Task" };

type Row = Record<string, unknown>;
type Key = { fieldKey: CryptoKey; keyRef: string };

async function makeKey(ref = REF): Promise<Key> {
  return { fieldKey: await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]), keyRef: ref };
}

/** A Worker that holds text and does what the real one does with a batch: nothing but write it, and count what is left. */
class FakeWorker {
  state: EncryptionState = "off";
  tables: Record<string, Row[]> = { task: [], note: [], tag: [], connector_change: [] };
  levels: Record<string, string> = { ...SHIPPED };
  stages: unknown = null;
  failAt = 0;
  failTimes = 0;
  batches = 0;
  calls: string[] = [];
  bodies: string[] = [];

  private cells(): { plain: number; sealed: number } {
    let plain = 0;
    let sealed = 0;
    const count = (v: unknown, lock = false): void => {
      if (typeof v !== "string" || v === "") return;
      // The Worker counts a lockable column's envelope as neither: it may be the lock's.
      if (isEnvelopeShape(v)) { if (!lock) sealed++; }
      else plain++;
    };
    for (const t of this.tables["task"] ?? []) {
      count(t["title"]);
      count(t["body"], true);
      for (const item of JSON.parse(String(t["checklist"] ?? "[]")) as { text: string }[]) count(item.text);
    }
    for (const n of this.tables["note"] ?? []) count(n["body"], true);
    for (const t of this.tables["tag"] ?? []) count(t["name"]);
    for (const c of this.tables["connector_change"] ?? []) count(c["before"]);
    for (const v of Object.values(this.levels)) count(v);
    count(typeof this.stages === "string" ? this.stages : null);
    return { plain, sealed };
  }

  report(): { state: EncryptionState; unsealed: number; sealed: number } {
    const { plain, sealed } = this.cells();
    return { state: this.state, unsealed: plain, sealed };
  }

  fetch: typeof fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    this.calls.push(`${method} ${url}`);
    if (typeof init?.body === "string") this.bodies.push(init.body);
    const send = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status });
    if (url === "/auth/me") return send(200, { signedIn: true, id: ACCOUNT });
    if (url === "/api/encryption" && method === "GET") return send(200, this.report());
    if (url === "/api/encryption/start") {
      const to = (JSON.parse(String(init?.body)) as { to: string }).to;
      if (this.state !== (to === "on" ? "off" : "on")) return send(409, { error: "Already moving." });
      this.state = to === "on" ? "turning_on" : "turning_off";
      return send(200, this.report());
    }
    if (url === "/api/encryption/finish") {
      const r = this.report();
      const left = this.state === "turning_on" ? r.unsealed : r.sealed;
      if (left > 0) return send(409, { error: `${left} cells are not moved yet.`, ...r });
      this.state = this.state === "turning_on" ? "on" : "off";
      return send(200, this.report());
    }
    if (url === "/api/encryption/batch") {
      this.batches++;
      if ((this.failAt > 0 && this.batches === this.failAt) || this.failTimes > 0) {
        if (this.failTimes > 0) this.failTimes--;
        return send(500, { error: "The server stumbled." });
      }
      const sealing = this.state === "turning_on";
      const { records } = JSON.parse(String(init?.body)) as { records: { kind: string; id: string; fields: Row }[] };
      if (records.length > 50) return send(400, { error: "too many" });
      for (const r of records) {
        for (const v of Object.values(r.fields)) {
          const texts = Array.isArray(v) ? (v as { text: string }[]).map((i) => i.text) : [String(v)];
          if (texts.some((t) => isEnvelopeShape(t) !== sealing)) return send(409, { error: "wrong way" });
        }
      }
      for (const r of records) {
        if (r.kind === "settings") {
          const { defaultStages, ...levels } = r.fields as Record<string, string>;
          const map: Record<string, string> = { levelSpace: "space", levelProject: "project", levelMilestone: "milestone", levelTask: "task" };
          for (const [f, v] of Object.entries(levels)) this.levels[map[f] ?? f] = v;
          if (defaultStages !== undefined) this.stages = defaultStages;
          continue;
        }
        const table = { tasks: "task", notes: "note", tags: "tag", connector_change: "connector_change" }[r.kind];
        const row = (this.tables[table ?? ""] ?? []).find((x) => x["id"] === r.id);
        if (row === undefined) return send(404, { error: "not found" });
        for (const [f, v] of Object.entries(r.fields)) row[f] = Array.isArray(v) ? JSON.stringify(v) : v;
      }
      return send(200, { written: records.length });
    }
    if (url === "/api/export") {
      const levelNames = { ...this.levels };
      return send(200, { tables: structuredClone(this.tables), settings: { levelNames, defaultStages: this.stages } });
    }
    return send(404, { error: "no" });
  };
}

let key: Key;
let worker: FakeWorker;
let api: ReturnType<typeof encryptionApi>;

const at = (table: string, i: number): Row => worker.tables[table]?.[i] ?? {};

const task = (n: number): Row => ({
  id: `t${n}`, title: `Task number ${n}`, body: n % 3 === 0 ? `Body of ${n}` : "",
  checklist: n % 5 === 0 ? JSON.stringify([{ text: `step a ${n}`, done: false }, { text: `step b ${n}`, done: true }]) : "[]",
});

async function seed(tasks: number): Promise<void> {
  worker.tables["task"] = Array.from({ length: tasks }, (_, n) => task(n));
  worker.tables["note"] = [{ id: "n1", body: "A note about the plan" }];
  worker.tables["tag"] = [{ id: "g1", name: "urgent" }];
  worker.tables["connector_change"] = [{ id: "c1", before: JSON.stringify({ title: "Old title" }) }];
  worker.levels = { space: "Studio", project: "Project", milestone: "Milestone", task: "Task" };
  worker.stages = [{ name: "Idea", kind: "open" }];
}

const run = (to: "on" | "off", more: Partial<Parameters<typeof encryptionRun>[1]> = {}) =>
  encryptionRun(to, { api, key, ...more });

beforeEach(async () => {
  key = await makeKey();
  worker = new FakeWorker();
  api = encryptionApi(worker.fetch);
});

describe("encryptionRun", () => {
  it("seals and then opens 5,000 tasks in batches of 50, with a bar that only moves forward", async () => {
    await seed(5000);
    const bars: Progress[] = [];
    const on = await run("on", { progress: (p) => bars.push(p) });
    expect(on).toEqual({ ok: true });
    expect(worker.state).toBe("on");
    expect(worker.batches).toBeGreaterThanOrEqual(100);
    expect(worker.report().unsealed).toBe(0);
    const stored = JSON.stringify(worker.tables) + JSON.stringify(worker.levels) + JSON.stringify(worker.stages);
    expect(stored).not.toContain("Task number");
    expect(stored).not.toContain("Old title");
    expect(stored).not.toContain("Studio");
    expect(stored).not.toContain("step a");
    expect(worker.bodies.join("")).not.toContain("Task number");
    const fractions = bars.map((b) => b.done / b.total);
    expect([...fractions].sort((a, b) => a - b)).toEqual(fractions);
    expect(fractions.at(-1)).toBe(1);

    const first = at("task", 5);
    expect(await open(key.fieldKey, String(first["title"]), { record: "t5", field: "title", keyRef: REF })).toBe("Task number 5");
    const note = at("note", 0);
    expect(await open(key.fieldKey, String(note["body"]), { record: "n1", field: "body", keyRef: REF })).toBe("A note about the plan");
    const settings = worker.bodies.join("");
    expect(settings).toContain(ACCOUNT);

    const off = await run("off");
    expect(off).toEqual({ ok: true });
    expect(worker.state).toBe("off");
    expect(worker.tables["task"]).toEqual(Array.from({ length: 5000 }, (_, n) => task(n)));
    expect(at("note", 0)["body"]).toBe("A note about the plan");
    expect(at("connector_change", 0)["before"]).toBe(JSON.stringify({ title: "Old title" }));
    expect(worker.levels["space"]).toBe("Studio");
    expect(worker.stages).toBe(JSON.stringify([{ name: "Idea", kind: "open" }]));
  }, 120_000);

  it("forgets kept data once it is on, and not when it is turned off", async () => {
    await seed(3);
    let forgot = 0;
    const states: EncryptionState[] = [];
    await run("on", { forget: async () => { forgot++; }, setState: (s) => states.push(s) });
    expect(forgot).toBe(1);
    expect(states.at(-1)).toBe("on");
    await run("off", { forget: async () => { forgot++; }, setState: (s) => states.push(s) });
    expect(forgot).toBe(1);
    expect(states.at(-1)).toBe("off");
  });

  it("stops at batch 40 and carries on from the server's state", async () => {
    await seed(5000);
    worker.failAt = 41;
    const stopped = await run("on");
    expect(stopped.ok).toBe(false);
    expect(worker.state).toBe("turning_on");
    expect(worker.batches).toBe(41);
    const left = worker.report().unsealed;
    expect(left).toBeGreaterThan(0);
    const bodiesBefore = worker.bodies.length;

    const resumed = await run("on");
    expect(resumed).toEqual({ ok: true });
    expect(worker.state).toBe("on");
    // Only what was left went again: the 40 batches already written were not sent twice.
    const sentAgain = worker.bodies.slice(bodiesBefore).filter((b) => b.includes('"records"'));
    const ids = new Set<string>();
    for (const b of sentAgain) for (const r of (JSON.parse(b) as { records: { id: string }[] }).records) ids.add(r.id);
    expect(ids.size).toBeLessThan(5000 - 39 * 50);
    expect(worker.report().unsealed).toBe(0);
  }, 120_000);

  it("says a failed batch stopped, writes nothing more, and can be tried again", async () => {
    await seed(120);
    worker.failTimes = 1;
    const before = JSON.stringify(worker.tables);
    const stopped = await run("on");
    expect(stopped).toMatchObject({ ok: false });
    expect(stopped.ok === false && stopped.said).toContain("stopped");
    expect(stopped.ok === false && stopped.said).toContain("The server stumbled.");
    expect(JSON.stringify(worker.tables)).toBe(before);
    expect(worker.state).toBe("turning_on");
    expect(await run("on")).toEqual({ ok: true });
    expect(worker.state).toBe("on");
  });

  it("refuses while the outbox holds writes, before it asks the Worker for anything", async () => {
    await seed(10);
    const refused = await run("on", { waiting: () => 2 });
    expect(refused).toEqual({ ok: false, said: WAITING });
    expect(worker.calls).toEqual([]);
    expect(worker.state).toBe("off");
  });

  it("never overwrites a field a wrong key cannot open", async () => {
    await seed(30);
    expect(await run("on")).toEqual({ ok: true });
    const sealedTables = JSON.stringify(worker.tables);
    const wrong = await makeKey();
    const refused = await run("off", { key: wrong });
    expect(refused.ok).toBe(false);
    expect(refused.ok === false && refused.said).toContain("doesn't open");
    expect(JSON.stringify(worker.tables)).toBe(sealedTables);
    expect(worker.state).toBe("turning_off");
    // The right key finishes it.
    expect(await run("off")).toEqual({ ok: true });
    expect(worker.state).toBe("off");
  });

  it("will not seal with a key that is not the account's", async () => {
    await seed(5);
    const refused = await run("on", { expectKeyRef: "zzzzzzzzzzz" });
    expect(refused.ok).toBe(false);
    expect(worker.calls).toEqual([]);
  });

  it("leaves a locked field, sealed by the lock, as the lock made it", async () => {
    await seed(3);
    const lockedBody = await seal(key.fieldKey, REF, "private", { record: "t1", field: "tasks.body" });
    at("task", 1)["body"] = lockedBody;
    expect(await run("on")).toEqual({ ok: true });
    expect(at("task", 1)["body"]).toBe(lockedBody);
    expect(await run("off")).toEqual({ ok: true });
    expect(at("task", 1)["body"]).toBe(lockedBody);
  });

  it("will not start one way while the other is running", async () => {
    await seed(5);
    worker.failAt = 1;
    await run("on");
    const refused = await run("off");
    expect(refused.ok).toBe(false);
    expect(worker.state).toBe("turning_on");
  });
});
