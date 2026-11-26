import { describe, expect, it } from "vitest";
import { parse } from "./smartDates.js";

// Tuesday 17 Nov 2026, 10:00 in Sydney (UTC+11).
const NOW = new Date("2026-11-16T23:00:00Z");
const ZONE = "Australia/Sydney";
const p = (text: string) => parse(text, NOW, ZONE);

describe("smartDates parse", () => {
  const dates: Array<[string, string, string]> = [
    ["call vet tomorrow", "call vet", "2026-11-18"],
    ["call vet today", "call vet", "2026-11-17"],
    ["plan next week", "plan", "2026-11-23"],
    ["bins monday", "bins", "2026-11-23"],
    ["bins tuesday", "bins", "2026-11-24"],
    ["bins wednesday", "bins", "2026-11-18"],
    ["bins thursday", "bins", "2026-11-19"],
    ["bins friday", "bins", "2026-11-20"],
    ["bins saturday", "bins", "2026-11-21"],
    ["bins sunday", "bins", "2026-11-22"],
    ["bins next friday", "bins", "2026-11-20"],
    ["TOMORROW call vet", "call vet", "2026-11-18"],
    ["Call Vet Tomorrow", "Call Vet", "2026-11-18"],
  ];
  it.each(dates)("%s", (text, title, when) => {
    const r = p(text);
    expect(r.title).toBe(title);
    expect(r.when).toBe(when);
    expect(r.repeat).toBeNull();
    expect(r.remindAt).toBeNull();
    expect(r.tokens).toHaveLength(1);
    expect(r.tokens[0]?.kind).toBe("date");
  });

  const repeats: Array<[string, string]> = [
    ["every day", "day"],
    ["every weekday", "weekday"],
    ["every monday", "week:1"],
    ["every tuesday", "week:2"],
    ["every wednesday", "week:3"],
    ["every thursday", "week:4"],
    ["every friday", "week:5"],
    ["every saturday", "week:6"],
    ["every sunday", "week:7"],
    ["every week", "week:2"],
    ["every month", "month"],
    ["EVERY Friday", "week:5"],
  ];
  it.each(repeats)("bins %s", (words, repeat) => {
    const r = p(`bins ${words}`);
    expect(r.title).toBe("bins");
    expect(r.repeat).toBe(repeat);
    expect(r.when).toBeNull();
    expect(r.tokens).toEqual([{ words, kind: "repeat" }]);
  });

  const times: Array<[string, string]> = [
    ["at 3pm", "2026-11-17T15:00"],
    ["at 3:30 pm", "2026-11-17T15:30"],
    ["at 15:00", "2026-11-17T15:00"],
    ["at 11am", "2026-11-17T11:00"],
    ["at 9pm", "2026-11-17T21:00"],
    ["at 3", "2026-11-17T15:00"],
    ["at 7", "2026-11-17T19:00"],
    ["at 8", "2026-11-18T08:00"],
    ["at 9", "2026-11-18T09:00"],
    ["at 9:30", "2026-11-18T09:30"],
    ["at 12", "2026-11-17T12:00"],
    ["at 12am", "2026-11-18T00:00"],
    ["AT 3PM", "2026-11-17T15:00"],
  ];
  it.each(times)("a time alone: %s", (words, remindAt) => {
    const r = p(`call vet ${words}`);
    expect(r.title).toBe("call vet");
    expect(r.remindAt).toBe(remindAt);
    expect(r.when).toBeNull();
    expect(r.tokens).toEqual([{ words, kind: "time" }]);
  });

  it("a time that has passed today moves to tomorrow", () => {
    expect(p("call at 10am").remindAt).toBe("2026-11-18T10:00");
    expect(p("call at 10:01am").remindAt).toBe("2026-11-17T10:01");
  });

  it("a time with a date lands on that date", () => {
    const r = p("call vet tomorrow at 3pm");
    expect(r.title).toBe("call vet");
    expect(r.when).toBe("2026-11-18");
    expect(r.remindAt).toBe("2026-11-18T15:00");
    expect(r.tokens.map((t) => t.kind)).toEqual(["date", "time"]);
    expect(p("call today at 9am").remindAt).toBe("2026-11-17T09:00");
  });

  it("words in any order, with spaces closed up", () => {
    const r = p("at 3pm  every friday   call   vet tomorrow");
    expect(r.title).toBe("call vet");
    expect(r.repeat).toBe("week:5");
    expect(r.when).toBe("2026-11-18");
    expect(r.remindAt).toBe("2026-11-18T15:00");
    expect(r.tokens.map((t) => t.kind)).toEqual(["time", "repeat", "date"]);
    expect(p("tomorrow call vet").title).toBe("call vet");
    expect(p("call tomorrow vet").title).toBe("call vet");
  });

  it("a weekday after every is a repeat, not a date", () => {
    const r = p("every monday bins");
    expect(r.when).toBeNull();
    expect(r.repeat).toBe("week:1");
  });

  it("uses the zone's calendar, not the instant's", () => {
    const at = new Date("2026-11-17T20:00:00Z");
    expect(parse("x today", at, "Australia/Sydney").when).toBe("2026-11-18");
    expect(parse("x today", at, "UTC").when).toBe("2026-11-17");
  });

  it("leaves text with none of them unchanged", () => {
    for (const text of ["call the vet", "  odd   spacing  ", "attorney", "todayish", "at the shop", ""]) {
      expect(p(text)).toEqual({ title: text, when: null, repeat: null, remindAt: null, tokens: [] });
    }
  });

  it("keeps the text when removing the words would leave no title", () => {
    expect(p("tomorrow")).toEqual({ title: "tomorrow", when: null, repeat: null, remindAt: null, tokens: [] });
  });

  it("ignores an hour or minute that is not real", () => {
    expect(p("call at 25:00").remindAt).toBeNull();
    expect(p("call at 3:75pm").remindAt).toBeNull();
    expect(p("call at 13pm").remindAt).toBeNull();
  });
});
