/**
 * The account clean-up: once a day, every account whose seven days after asking to go have
 * passed is removed with all its rows. One job on the one cron the Worker has; the deletes
 * themselves live in `store.ts`. The copy's own owner is never removed, whatever the table says.
 */
import type { Job } from "./tick.js";
import { openStore } from "./store.js";

export const accountPurgeJob: Job = {
  name: "account-purge",
  // Once a day, at 03:45 UTC.
  schedule: "45 3 * * *",
  async run(now, env) {
    const owner = "OWNER" in env && typeof env.OWNER === "string" ? env.OWNER : "";
    await openStore(env, () => now).purgeAccounts(owner);
  },
};
