/** What 0023 leaves on an account until its owner chooses: the shipped words, the map, every Extra on. */
export const PROFILE_DEFAULTS = {
  levelNames: { space: "Space", project: "Project", milestone: "Milestone", task: "Task" },
  defaultStages: null,
  startOn: "map",
  extras: { smartDates: true, singleKeys: true, recent: true, rings: true, comingUp: true, burst: true },
  timeZone: null,
  encryption: "off",
} as const;
