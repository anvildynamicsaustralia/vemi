import { describe, expect, it } from "vitest";
import { age, dayStamp, fullDate, longDate, shortDate, shortName } from "./format.js";

describe("dates as the interface writes them", () => {
  it("drops the year only when it is this year", () => {
    expect(shortDate("2026-10-12", "2026-09-14")).toBe("12 oct");
    expect(shortDate("2027-01-03", "2026-09-14")).toBe("3 jan 2027");
    expect(shortDate("2026-10-12")).toBe("12 oct");
  });

  it("stamps a day with its weekday", () => {
    expect(dayStamp("2026-09-14")).toBe("mon 14 sep");
    expect(dayStamp("2026-02-28")).toBe("sat 28 feb");
  });

  it("passes through what it cannot read rather than inventing a date", () => {
    expect(shortDate("soon")).toBe("soon");
    expect(dayStamp("soon")).toBe("soon");
  });
});

describe("age", () => {
  const now = new Date("2026-09-14T12:00:00Z");
  it("says how long ago in the fewest words that stay true", () => {
    expect(age("2026-09-14T11:59:30Z", now)).toBe("just now");
    expect(age("2026-09-14T11:50:00Z", now)).toBe("10 min ago");
    expect(age("2026-09-14T09:00:00Z", now)).toBe("3 h ago");
    expect(age("2026-09-13T06:00:00Z", now)).toBe("30 h ago");
    expect(age("2026-09-13T00:00:00Z", now)).toBe("a day ago");
    expect(age("2026-09-12T00:00:00Z", now)).toBe("2 days ago");
    expect(age("2026-09-10T12:00:00Z", now)).toBe("4 days ago");
    expect(age("2026-09-14T12:05:00Z", now)).toBe("just now");
  });
});

describe("shortName", () => {
  it("is the first word, kept short", () => {
    expect(shortName("Black Dingo Studios")).toBe("Black");
    expect(shortName("Extraordinarilylong venture")).toBe("Extraordinar");
  });
});

describe("longDate", () => {
  it("writes the month out, as Add's summary says it", () => {
    expect(longDate("2026-09-24", "2026-09-18")).toBe("24 September");
    expect(longDate("2027-01-02", "2026-09-18")).toBe("2 January 2027");
    expect(longDate("not a date")).toBe("not a date");
  });
});

describe("fullDate", () => {
  it("says the weekday, the day, the month and the year, as a calendar's day is read out", () => {
    expect(fullDate("2026-09-24")).toBe("Thursday 24 September 2026");
    expect(fullDate("2027-01-03")).toBe("Sunday 3 January 2027");
  });

  it("passes through what it cannot read", () => {
    expect(fullDate("soon")).toBe("soon");
  });
});
