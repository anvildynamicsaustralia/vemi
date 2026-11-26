import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { MADE_SIGN_IN, moveToCloud, textSource, type MoveInput, type MoveSource } from "./moveToCloud.js";

const ADDRESS = "https://mine.sub.workers.dev";
const PASSWORD = "a-long-new-password";
const CODE = "claim-code-0001";
const DOCUMENT = { format: "vemi-export", version: 2, exportedAt: "2026-11-22T00:00:00.000Z", about: "x", settings: {}, tables: { task: [{ id: "t1", title: "Buy milk" }] } };

const source: MoveSource = { read: () => Promise.resolve(DOCUMENT) };
const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const GOOD = { counts: { task: 1 }, locked: [], ids: { t1: "n1" }, recoveryCode: "rec-0000", handOver: "hand-token" };

interface Call { url: string; init: RequestInit }
function stub(...answers: (Response | Error)[]): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  let at = 0;
  const f = (url: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    calls.push({ url: String(url), init: init ?? {} });
    const answer = answers[Math.min(at++, answers.length - 1)];
    return answer instanceof Error || answer === undefined ? Promise.reject(answer ?? new Error("none")) : Promise.resolve(answer.clone());
  };
  return { fetch: f as typeof fetch, calls };
}
const input = (fetchLike: typeof fetch, over: Partial<MoveInput> = {}): MoveInput => ({
  address: ADDRESS, code: CODE, email: "sam@example.com", password: PASSWORD, source, fetch: fetchLike, wait: () => Promise.resolve(), ...over,
});

describe("moveToCloud", () => {
  it("posts the code, email, password and document to the new copy's door, plain", async () => {
    const s = stub(json(200, GOOD));
    const done = await moveToCloud(input(s.fetch));
    expect(done).toMatchObject({ ok: true, counts: { task: 1 }, recoveryCode: "rec-0000", openLink: `${ADDRESS}/auth/move-in?t=hand-token` });
    expect(s.calls).toHaveLength(1);
    const [call] = s.calls;
    expect(call?.url).toBe(`${ADDRESS}/setup/move`);
    expect(call?.init.method).toBe("POST");
    expect(call?.init.credentials).toBe("omit");
    expect(call?.init.referrerPolicy).toBe("no-referrer");
    expect(JSON.parse(String(call?.init.body))).toEqual({ code: CODE, email: "sam@example.com", password: PASSWORD, document: DOCUMENT });
  });

  it("retries once on a network error with the same body", async () => {
    const s = stub(new TypeError("Failed to fetch"), json(200, GOOD));
    const done = await moveToCloud(input(s.fetch));
    expect(done.ok).toBe(true);
    expect(s.calls).toHaveLength(2);
    expect(s.calls[1]?.init.body).toBe(s.calls[0]?.init.body);
  });

  it("says the copy is still starting after two network errors, and sends no third", async () => {
    const s = stub(new TypeError("Failed to fetch"));
    const done = await moveToCloud(input(s.fetch));
    expect(done).toEqual({ ok: false, reason: "Your new copy is still starting. Try again in a minute." });
    expect(s.calls).toHaveLength(2);
  });

  it.each([
    [403, { error: "This copy cannot be set up that way." }, "Your new copy did not take the code for this move."],
    [409, { error: "This copy already has an owner." }, "This copy already has an owner, so nothing was copied into it."],
    [413, { error: "That file is too big to move in one go." }, "That file is too big to move in one go."],
    [502, "<html>bad gateway</html>", "Your new copy is still starting. Try again in a minute."],
    [404, "Not found", "Your new copy is still starting. Try again in a minute."],
  ])("maps a %i refusal to one calm sentence", async (status, body, sentence) => {
    const s = stub(typeof body === "string" ? new Response(body, { status }) : json(status, body));
    const done = await moveToCloud(input(s.fetch));
    expect(done).toEqual({ ok: false, reason: sentence });
    expect(s.calls).toHaveLength(1);
  });

  it("says the store's own sentence for a file or password the copy refuses", async () => {
    const s = stub(json(400, { error: "Use at least 10 characters." }));
    expect(await moveToCloud(input(s.fetch))).toEqual({ ok: false, reason: "Use at least 10 characters." });
  });

  it("says the copy was made but the stuff did not arrive, in the copy's words", async () => {
    const said = "The copy was made but your stuff did not arrive. Sign in and move again.";
    const s = stub(json(500, { error: said }));
    expect(await moveToCloud(input(s.fetch))).toEqual({ ok: false, reason: said });
  });

  it("does not send anything when the file is not a VEMI export", async () => {
    const s = stub(json(200, GOOD));
    const bad = textSource("not json at all");
    expect(await moveToCloud(input(s.fetch, { source: bad }))).toEqual({ ok: false, reason: "That file is not a VEMI export." });
    expect(await moveToCloud(input(s.fetch, { source: textSource(JSON.stringify({ format: "other" })) }))).toEqual({ ok: false, reason: "That file is not a VEMI export." });
    expect(s.calls).toHaveLength(0);
  });

  it("carries the password to the new copy and to nowhere else", async () => {
    const s = stub(new TypeError("Failed to fetch"), json(200, GOOD));
    await moveToCloud(input(s.fetch));
    for (const call of s.calls) {
      expect(new URL(call.url).origin).toBe(ADDRESS);
      expect(call.url).not.toContain(PASSWORD);
      expect(JSON.stringify(call.init.headers ?? {})).not.toContain(PASSWORD);
      expect(String(call.init.body)).toContain(PASSWORD);
    }
  });

  it("is the only code in the helper that handles the password next to a request", () => {
    for (const file of ["handOver.ts", "relayFetch.ts", "loadRelease.ts"]) {
      expect(readFileSync(`src/web/get/${file}`, "utf8"), file).not.toMatch(/password/i);
    }
    expect(readFileSync("src/web/moveToCloud.ts", "utf8")).not.toMatch(/relay|vemi-front|api\.github|\/get\//);
  });

  it("keeps the password and code out of the answer's open link and reasons", async () => {
    const s = stub(json(200, GOOD));
    const done = await moveToCloud(input(s.fetch));
    const text = JSON.stringify(done);
    expect(text).not.toContain(PASSWORD);
    expect(text).not.toContain(CODE);
  });
});

describe("a retry after the account was made", () => {
  it("ends with its own sentence, marked final, when the copy has an owner and sends no hand-over", async () => {
    const s = stub(json(200, { moved: false, counts: { task: 1 }, confirm: "replace" }));
    expect(await moveToCloud(input(s.fetch))).toEqual({ ok: false, reason: MADE_SIGN_IN, final: true });
    expect(MADE_SIGN_IN).not.toMatch(/still starting/);
    expect(s.calls).toHaveLength(1);
  });
});

describe("a move that carried locked content", () => {
  it("marks the hand-over link so the new copy starts its finishing pass", async () => {
    const answer = { counts: { task: 1 }, handOver: "hand-token", recoveryCode: "rec-0000" };
    const sent = async () => new Response(JSON.stringify(answer), { status: 200 });
    const done = await moveToCloud({ address: ADDRESS, code: "c", email: "me@example.com", password: "pw", source: textSource(JSON.stringify({ format: "vemi-export", tables: {} })), finish: true, fetch: sent as typeof fetch });
    expect(done).toMatchObject({ ok: true, openLink: `${ADDRESS}/auth/move-in?t=hand-token&finish=1` });
  });
});
