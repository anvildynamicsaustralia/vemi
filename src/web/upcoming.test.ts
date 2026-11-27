import { describe, expect, it } from "vitest";
import { upcomingCount, upcomingGroups } from "./upcoming.js";

const t = (id: string, dueOn: string | null, finished = false) => ({ id, title: id, dueOn, finished });

describe("upcomingGroups", () => {
  const groups = upcomingGroups([
    t("late", "2026-11-20"), t("later-late", "2026-11-25"), t("today", "2026-11-27"),
    t("tomorrow", "2026-11-28"), t("done", "2026-11-28", true), t("undated", null), t("far", "2027-01-30"),
  ], "2026-11-27", new Set(["late", "later-late"]));

  it("puts what the Worker marks overdue first, as one group", () => {
    expect(groups[0]).toEqual({ on: null, tasks: [t("late", "2026-11-20"), t("later-late", "2026-11-25")] });
  });
  it("then every one of fourteen days from today, empty ones too", () => {
    expect(groups.slice(1).map((g) => g.on)).toHaveLength(14);
    expect(groups[1]?.on).toBe("2026-11-27");
    expect(groups[1]?.tasks.map((x) => x.id)).toEqual(["today"]);
    expect(groups[2]?.tasks.map((x) => x.id)).toEqual(["tomorrow"]);
    expect(groups[3]?.tasks).toEqual([]);
  });
  it("leaves out what is finished, undated or past the two weeks, and counts the rest", () => {
    expect(upcomingCount(groups)).toBe(4);
  });
  it("has no overdue group when nothing is late", () => {
    expect(upcomingGroups([t("a", "2026-11-28")], "2026-11-27", new Set())[0]?.on).toBe("2026-11-27");
  });
});
