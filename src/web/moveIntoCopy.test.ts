import { describe, expect, it, vi } from "vitest";
import { askCopy, BAD_CODE, copyOrigin, DOOR_SHUT, NOT_VEMI, OTHER_VERSION, tableCounts } from "./moveIntoCopy.js";

const DOC = { format: "vemi-export", version: 2, tables: { task: [{ id: "a" }, { id: "b" }], note: [{ id: "n" }], venture: [] } };
const ADDRESS = "https://mine.example.workers.dev";

const answer = (status: number, body: unknown, type = "application/json"): Response =>
  new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "content-type": type } });

const ask = (reply: () => Promise<Response>, confirm = false) =>
  askCopy({ address: ADDRESS, code: "CODE-1", document: DOC, confirm, fetch: vi.fn(reply) as unknown as typeof fetch });

describe("copyOrigin", () => {
  it("keeps the origin of an https address", () => {
    expect(copyOrigin(" https://mine.example.workers.dev/ ")).toBe(ADDRESS);
    expect(copyOrigin("https://mine.example.workers.dev/somewhere?x=1")).toBe(ADDRESS);
  });
  it("refuses anything that is not an https address", () => {
    expect(copyOrigin("mine.example.workers.dev")).toBeNull();
    expect(copyOrigin("http://mine.example.workers.dev")).toBeNull();
    expect(copyOrigin("")).toBeNull();
  });
});

describe("tableCounts", () => {
  it("counts the rows of each table the document holds", () => {
    expect(tableCounts(DOC)).toEqual({ task: 2, note: 1, venture: 0 });
    expect(tableCounts({})).toEqual({});
  });
});

describe("askCopy", () => {
  it("sends the code and the document to the copy's own door, with nothing else", async () => {
    const fetcher = vi.fn(async () => answer(200, { moved: false, counts: { task: 2 }, holds: { task: 5 }, confirm: "replace" }));
    const out = await askCopy({ address: ADDRESS + "/", code: "CODE-1", document: DOC, confirm: false, fetch: fetcher as unknown as typeof fetch });
    expect(out).toEqual({ ok: true, counts: { task: 2 }, holds: { task: 5 } });
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${ADDRESS}/setup/move`);
    expect(init.credentials).toBe("omit");
    expect(init.referrerPolicy).toBe("no-referrer");
    expect(JSON.parse(init.body as string)).toEqual({ code: "CODE-1", document: DOC });
  });

  it("adds replace only when told to go on, and reads the done answer", async () => {
    const fetcher = vi.fn(async () => answer(200, { counts: { task: 2, note: 1 }, locked: [], ids: {} }));
    const out = await askCopy({ address: ADDRESS, code: "CODE-1", document: DOC, confirm: true, fetch: fetcher as unknown as typeof fetch });
    expect(out).toEqual({ ok: true, counts: { task: 2, note: 1 }, holds: {} });
    const init = (fetcher.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(JSON.parse(init.body as string)).toEqual({ code: "CODE-1", document: DOC, confirm: "replace" });
  });

  it("stops on an address that is not an https address without asking", async () => {
    const fetcher = vi.fn();
    const out = await askCopy({ address: "nope", code: "c", document: DOC, confirm: false, fetch: fetcher as unknown as typeof fetch });
    expect(out).toEqual({ ok: false, reason: NOT_VEMI });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("says it is not VEMI when the answer is a page, or does not look like one", async () => {
    expect(await ask(async () => answer(200, "<html></html>", "text/html"))).toEqual({ ok: false, reason: NOT_VEMI });
    expect(await ask(async () => answer(404, "gone", "text/html"))).toEqual({ ok: false, reason: NOT_VEMI });
    expect(await ask(async () => answer(200, { hello: "world" }))).toEqual({ ok: false, reason: NOT_VEMI });
  });

  it("says another version when the copy has no such door or will not read the file", async () => {
    expect(await ask(async () => answer(404, { error: "not found" }))).toEqual({ ok: false, reason: OTHER_VERSION });
    expect(await ask(async () => answer(400, { error: "this export is version 9; this copy reads 1 and 2" }))).toEqual({ ok: false, reason: OTHER_VERSION });
  });

  it("says the door is shut when the browser could not read an answer", async () => {
    expect(await ask(async () => { throw new TypeError("Failed to fetch"); })).toEqual({ ok: false, reason: DOOR_SHUT });
  });

  it("says the code did not work on a refusal from the copy", async () => {
    expect(await ask(async () => answer(403, { error: "This copy cannot be set up that way." }))).toEqual({ ok: false, reason: BAD_CODE });
  });

  it("gives the copy's own short sentence for any other refusal", async () => {
    expect(await ask(async () => answer(400, { error: "Nothing to move." }))).toEqual({ ok: false, reason: "Nothing to move." });
  });

  it("holds no em-dash in any sentence", () => {
    for (const s of [NOT_VEMI, DOOR_SHUT, OTHER_VERSION, BAD_CODE]) expect(s).not.toContain(String.fromCharCode(0x2014));
  });
});
