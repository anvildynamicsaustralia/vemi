import { describe, expect, it } from "vitest";
import { capBytes, MOVE_LIMIT, moveCodeOk, moveCors } from "./move.js";

const OK = "https://get.example.com";

describe("moveCors", () => {
  it("answers the exact configured origin", () => {
    expect(moveCors(OK, OK)).toEqual({
      "access-control-allow-origin": OK,
      "access-control-allow-methods": "POST, OPTIONS",
      "access-control-allow-headers": "content-type",
      vary: "origin",
    });
  });
  it("never grants credentials", () => {
    expect(moveCors(OK, OK)).not.toHaveProperty("access-control-allow-credentials");
  });
  it.each([
    ["wildcard", "*"],
    ["null", "null"],
    ["trailing slash", `${OK}/`],
    ["prefix", `${OK}.evil.com`],
    ["path", `${OK}/x`],
    ["suffix", "https://xget.example.com"],
    ["other scheme", "http://get.example.com"],
    ["upper case", OK.toUpperCase()],
    ["empty", ""],
  ])("gives nothing for %s", (_name, asked) => {
    expect(moveCors(asked, OK)).toEqual({});
  });
  it("gives nothing without an origin", () => {
    expect(moveCors(null, OK)).toEqual({});
  });
  it("gives nothing when none is configured", () => {
    expect(moveCors("", "")).toEqual({});
    expect(moveCors("*", "")).toEqual({});
    expect(moveCors("null", "null")).toEqual({});
    expect(moveCors("*", "*")).toEqual({});
  });
});

const post = (body: BodyInit, headers: Record<string, string> = {}): Request =>
  new Request("https://copy.example/setup/move", { method: "POST", body, headers });

describe("capBytes", () => {
  it("is 20 MB", () => {
    expect(MOVE_LIMIT).toBe(20 * 1024 * 1024);
  });
  it("hands back the text of a body inside the limit", async () => {
    expect(await capBytes(post('{"a":1}'))).toEqual({ ok: true, text: '{"a":1}' });
  });
  it("accepts a body of exactly the limit", async () => {
    expect((await capBytes(post("x".repeat(100)), 100)).ok).toBe(true);
  });
  it("refuses a body one byte over with 413 and one sentence", async () => {
    const got = await capBytes(post("x".repeat(101)), 100);
    expect(got.ok).toBe(false);
    if (got.ok) return;
    expect(got.response.status).toBe(413);
    expect(await got.response.json()).toEqual({ error: "That file is too big to move in one go." });
  });
  it("refuses on the declared length", async () => {
    const got = await capBytes(post("small", { "content-length": String(MOVE_LIMIT + 1) }));
    expect(got.ok).toBe(false);
    if (!got.ok) expect(got.response.status).toBe(413);
  });
  it("counts bytes, not characters", async () => {
    expect((await capBytes(post("é".repeat(60)), 100)).ok).toBe(false);
  });
  it("takes an empty body as empty text", async () => {
    expect(await capBytes(new Request("https://copy.example/setup/move", { method: "POST" }))).toEqual({ ok: true, text: "" });
  });
});

describe("moveCodeOk", () => {
  it("accepts the same code only", async () => {
    expect(await moveCodeOk("abc", "abc")).toBe(true);
    expect(await moveCodeOk("abd", "abc")).toBe(false);
    expect(await moveCodeOk("", "abc")).toBe(false);
    expect(await moveCodeOk(undefined, "abc")).toBe(false);
    expect(await moveCodeOk(7, "abc")).toBe(false);
  });
});
