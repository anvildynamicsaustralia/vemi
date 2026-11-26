/**
 * The connector's daily clean-up: codes that ran out, grants whose refresh token ran out or
 * that were revoked long ago, and apps that asked and were never let in. One job on the one
 * cron the Worker has; the deletes themselves live in `store.ts`.
 */
import type { Job } from "./tick.js";
import { openStore } from "./store.js";

export const connectorPurgeJob: Job = {
  name: "connector-purge",
  // Once a day, at 03:30 UTC.
  schedule: "30 3 * * *",
  async run(now, env) {
    await openStore(env, () => now).purgeConnector();
  },
};
