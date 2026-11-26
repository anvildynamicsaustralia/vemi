import { describe, expect, it } from "vitest";
import { envelopeLimit } from "./encryptedFields.js";
import { parsePushPayload } from "./pushPayload.js";

const task = { kind: "task", title: "Call the bank", body: "Due now", taskId: "t1", at: "2026-11-18T09:00", tag: "task-t1" };

describe("parsePushPayload", () => {
  it("accepts each kind and keeps the known keys", () => {
    expect(parsePushPayload(task)).toEqual({ ok: true, value: task });
    expect(parsePushPayload({ kind: "morning", title: "Today", body: "3 reminders", count: 3, tag: "morning" }).ok).toBe(true);
    expect(parsePushPayload({ kind: "held", title: "Held", body: "2 held", count: 2, tag: "held" }).ok).toBe(true);
    expect(parsePushPayload({ kind: "test", title: "VEMI", body: "Reminders work here", tag: "test" }).ok).toBe(true);
  });

  it("refuses what is not a payload", () => {
    for (const bad of [null, "x", 4, [], {}]) expect(parsePushPayload(bad).ok).toBe(false);
    expect(parsePushPayload({ ...task, kind: "other" }).ok).toBe(false);
    expect(parsePushPayload({ ...task, extra: 1 }).ok).toBe(false);
    expect(parsePushPayload({ ...task, title: 4 }).ok).toBe(false);
    expect(parsePushPayload({ ...task, tag: "" }).ok).toBe(false);
    expect(parsePushPayload({ ...task, at: "tomorrow" }).ok).toBe(false);
    expect(parsePushPayload({ ...task, count: -1 }).ok).toBe(false);
    expect(parsePushPayload({ ...task, count: 1.5 }).ok).toBe(false);
  });

  it("wants a task message to name its task", () => {
    const { taskId: _gone, ...bare } = task;
    expect(parsePushPayload(bare).ok).toBe(false);
  });
});

describe("a sealed title", () => {
  const envelope = `v1.${"a".repeat(11)}.${"b".repeat(16)}.${"c".repeat(40)}`;
  const sealed = { ...task, title: "You have a reminder", body: "", sealedTitle: envelope };

  it("is kept on a message that names its task", () => {
    expect(parsePushPayload(sealed)).toEqual({ ok: true, value: sealed });
  });

  it("is refused when it is plain text, empty, or has no task to be bound to", () => {
    expect(parsePushPayload({ ...sealed, sealedTitle: "Call the bank" }).ok).toBe(false);
    expect(parsePushPayload({ ...sealed, sealedTitle: "" }).ok).toBe(false);
    expect(parsePushPayload({ ...sealed, sealedTitle: 4 }).ok).toBe(false);
    const { taskId: _gone, ...bare } = sealed;
    expect(parsePushPayload({ ...bare, kind: "morning", count: 2 }).ok).toBe(false);
  });

  it("holds the envelope of a 300 character title within one push record", () => {
    const longest = `v1.${"a".repeat(11)}.${"b".repeat(16)}.${"c".repeat(envelopeLimit(300) - 32)}`;
    expect(longest.length).toBe(envelopeLimit(300));
    expect(parsePushPayload({ ...sealed, sealedTitle: longest }).ok).toBe(true);
    expect(new TextEncoder().encode(JSON.stringify({ ...sealed, sealedTitle: longest })).length).toBeLessThan(4096 - 18);
    expect(parsePushPayload({ ...sealed, sealedTitle: `${longest}cc` }).ok).toBe(false);
  });
});
