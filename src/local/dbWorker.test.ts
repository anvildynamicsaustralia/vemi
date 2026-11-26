import { describe, expect, it } from "vitest";
import type { Change } from "@vemi/shared";
import { runDbWorker, type WorkerIn, type WorkerOut, type WorkerScope, openStorageWith, HELD_SAID } from "./dbWorker.js";
import { openSqliteEngine } from "./sqliteEngine.js";

const ORIGIN = "https://vemi.test";

function fakeScope(): { scope: WorkerScope; out: WorkerOut[]; tell(message: WorkerIn): void; next(type: WorkerOut["type"], count?: number): Promise<void> } {
  const out: WorkerOut[] = [];
  const scope: WorkerScope = { onmessage: null, postMessage: (message) => { out.push(message); } };
  return {
    scope,
    out,
    tell: (message) => scope.onmessage?.({ data: message }),
    next: async (type, count = 1) => {
      for (let i = 0; i < 200 && out.filter((m) => m.type === type).length < count; i++) await new Promise((r) => setTimeout(r, 10));
    },
  };
}

const request = (method: string, path: string, body?: unknown) => ({
  method,
  url: `${ORIGIN}${path}`,
  headers: (body === undefined ? [] : [["content-type", "application/json"]]) as [string, string][],
  body: body === undefined ? null : (new TextEncoder().encode(JSON.stringify(body)).buffer as ArrayBuffer),
});

describe("the database worker", () => {
  it("opens, says whether it is volatile, and answers requests in the order they came", async () => {
    const w = fakeScope();
    const changes: Change[] = [];
    runDbWorker(w.scope, {
      openStorage: async () => ({ engine: await openSqliteEngine(), volatile: true }),
      origin: ORIGIN, timeZone: "Australia/Sydney", post: (c) => { changes.push(c); },
    });
    // Sent before it is open: still answered in order once it is.
    w.tell({ type: "open" });
    w.tell({ type: "request", id: 1, wire: request("GET", "/auth/me") });
    w.tell({ type: "request", id: 2, wire: request("GET", "/api/front") });
    await w.next("answer", 2);
    expect(w.out.map((m) => m.type)).toEqual(["ready", "answer", "answer"]);
    expect(w.out[0]).toEqual({ type: "ready", volatile: true });
    expect(w.out.slice(1).map((m) => (m.type === "answer" ? m.id : -1))).toEqual([1, 2]);
    const me = w.out[1];
    expect(me?.type === "answer" ? me.wire.status : 0).toBe(200);
  });

  it("answers failed for a request before the database is open, and says broken if it cannot open", async () => {
    const early = fakeScope();
    runDbWorker(early.scope, { openStorage: async () => ({ engine: await openSqliteEngine(), volatile: false }), origin: ORIGIN, timeZone: "UTC", post: () => undefined });
    early.tell({ type: "request", id: 7, wire: request("GET", "/auth/me") });
    await early.next("failed");
    expect(early.out[0]).toMatchObject({ type: "failed", id: 7 });

    const broken = fakeScope();
    runDbWorker(broken.scope, { openStorage: async () => { throw new Error("no storage"); }, origin: ORIGIN, timeZone: "UTC", post: () => undefined });
    broken.tell({ type: "open" });
    await broken.next("broken");
    expect(broken.out[0]).toEqual({ type: "broken", message: "no storage" });
  });

  it("closes the database and says so", async () => {
    const w = fakeScope();
    runDbWorker(w.scope, { openStorage: async () => ({ engine: await openSqliteEngine(), volatile: false }), origin: ORIGIN, timeZone: "UTC", post: () => undefined });
    w.tell({ type: "open" });
    w.tell({ type: "close" });
    w.tell({ type: "request", id: 1, wire: request("GET", "/auth/me") });
    await w.next("failed");
    expect(w.out.map((m) => m.type)).toEqual(["ready", "closed", "failed"]);
  });
});

describe("choosing between the file and memory", () => {
  const memory = async () => openSqliteEngine();
  const held = Object.assign(new Error("Access Handles cannot be created if there is another open Access Handle"), { name: "NoModificationAllowedError" });

  it("never opens an empty memory copy over a file that is only held for now", async () => {
    let tries = 0;
    await expect(openStorageWith({ openFile: async () => { tries++; throw held; }, openMemory: memory, sleep: async () => undefined })).rejects.toThrow(HELD_SAID);
    expect(tries).toBe(8);
  });

  it("opens the file when the other tab lets go in time", async () => {
    let tries = 0;
    const storage = await openStorageWith({
      openFile: async () => { if (++tries < 4) throw held; return openSqliteEngine(); },
      openMemory: async () => { throw new Error("memory must not be used"); },
      sleep: async () => undefined,
    });
    expect(storage.volatile).toBe(false);
  });

  it("falls back to memory, and says so, in a browser that cannot keep a file", async () => {
    let tries = 0;
    const storage = await openStorageWith({ openFile: async () => { tries++; throw new TypeError("no file system"); }, openMemory: memory, sleep: async () => undefined });
    expect(storage.volatile).toBe(true);
    expect(tries).toBe(3);
  });
});
