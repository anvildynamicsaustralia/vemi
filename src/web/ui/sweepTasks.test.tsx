import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { defaultWordsIn } from "./sweepSpaces.test.js";

/**
 * The words sweep for the task and project screens: no visible string names a level in the
 * shipped words. Renamed levels must never meet Space, Project, Milestone or Task here.
 */
const FILES = [
  "TaskDetail", "TaskPage", "TaskMarks", "TaskOptions", "Compose", "Today", "TodayRow", "ReminderBanner",
  "ProjectPage", "ProjectHead", "ProjectBrief", "ProjectMilestones", "ProjectSide", "Review", "RiskTag",
  "NeedsYou", "Register", "Ledger",
  "Account", "AccountAbout", "AccountAi", "AccountData", "AccountExtras", "AccountLook", "AccountNames",
  "AccountPeople", "AccountProfile", "AccountReminders", "SpaceSettings",
];

describe("task and project screens carry no default level word", () => {
  for (const name of FILES) {
    it(`${name}.tsx`, () => {
      const src = readFileSync(new URL(`./${name}.tsx`, import.meta.url), "utf8");
      expect(defaultWordsIn(src)).toEqual([]);
    });
  }
});
