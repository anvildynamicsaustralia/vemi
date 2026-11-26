import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clockOf, inOneHour, onReminder, showReminder, snoozePatch, type Reminder } from "./reminderEvent.js";

describe("reminder event", () => {
  beforeEach(() => {
    (globalThis as { window?: unknown }).window = new EventTarget();
  });
  afterEach(() => {
    delete (globalThis as { window?: unknown }).window;
  });

  it("delivers showReminder to a listener", () => {
    const seen: Reminder[] = [];
    onReminder((r) => seen.push(r));
    showReminder({ taskId: "t1", at: "2026-11-17T14:00" });
    expect(seen).toEqual([{ taskId: "t1", at: "2026-11-17T14:00" }]);
  });

  it("fires the window event named vemi:reminder", () => {
    let name = "";
    globalThis.window.addEventListener("vemi:reminder", (e) => { name = e.type; });
    showReminder({ taskId: "t1", at: "2026-11-17T14:00" });
    expect(name).toBe("vemi:reminder");
  });

  it("a second reminder is delivered after the first", () => {
    const seen: string[] = [];
    onReminder((r) => seen.push(r.taskId));
    showReminder({ taskId: "a", at: "2026-11-17T14:00" });
    showReminder({ taskId: "b", at: "2026-11-17T15:00" });
    expect(seen).toEqual(["a", "b"]);
  });

  it("stops listening when asked", () => {
    const seen: Reminder[] = [];
    const stop = onReminder((r) => seen.push(r));
    stop();
    showReminder({ taskId: "t1", at: "2026-11-17T14:00" });
    expect(seen).toEqual([]);
  });
});

describe("one hour on", () => {
  it("adds an hour to the wall time", () => {
    expect(snoozePatch("2026-11-17T14:00")).toEqual({ remindAt: "2026-11-17T15:00" });
    expect(inOneHour("2026-11-17T09:45")).toBe("2026-11-17T10:45");
  });
  it("rolls over midnight, month and year", () => {
    expect(inOneHour("2026-11-17T23:30")).toBe("2026-11-18T00:30");
    expect(inOneHour("2026-12-31T23:00")).toBe("2027-01-01T00:00");
  });
  it("leaves something that is not a wall time alone", () => {
    expect(inOneHour("soon")).toBe("soon");
  });
  it("says the clock the way the banner does", () => {
    expect(clockOf("2026-11-17T14:00")).toBe("2:00 pm");
    expect(clockOf("2026-11-17T00:05")).toBe("12:05 am");
    expect(clockOf("2026-11-17T12:00")).toBe("12:00 pm");
  });
});
