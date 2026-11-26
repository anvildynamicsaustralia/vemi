/**
 * The one scheduled tick. Cloudflare calls the Worker once a minute; `tick` runs each
 * registered job whose schedule matches that minute (UTC) and no other.
 *
 * Free Workers allow five cron triggers an account, so every scheduled job shares this one.
 * Later phases add their job to `jobs`; none adds a second trigger.
 */
import { RELEASE_FEED, RELEASE_PUBLIC_KEY, VERSION } from "@vemi/shared";
import { accountPurgeJob } from "./accountPurge.js";
import { connectorPurgeJob } from "./connectorPurge.js";
import { remindersJob } from "./reminders.js";
import type { StoreEnv } from "./store.js";
import { createUpdateCheckJob } from "./updateCheck.js";

export interface Job {
  readonly name: string;
  /**
   * Five cron fields: minute, hour, day of month, month, day of week. Each field is a star,
   * a star-slash-n step, or a number.
   */
  readonly schedule: string;
  readonly run: (now: Date, env: StoreEnv) => void | Promise<void>;
}

/** The check for a newer release, built with the feed and key this build was given. */
export const updateCheckJob: Job = createUpdateCheckJob({
  feed: RELEASE_FEED,
  publicKey: RELEASE_PUBLIC_KEY,
  version: VERSION,
  fetch: (url, init) => fetch(url, init),
});

/** The registered jobs, all on the one cron. */
export const jobs: readonly Job[] = [remindersJob, connectorPurgeJob, accountPurgeJob, updateCheckJob];

function fieldMatches(field: string, value: number): boolean {
  if (field === "*") return true;
  if (field.startsWith("*/")) return value % Number(field.slice(2)) === 0;
  return Number(field) === value;
}

function due(schedule: string, now: Date): boolean {
  const fields = schedule.trim().split(/\s+/);
  const values = [
    now.getUTCMinutes(),
    now.getUTCHours(),
    now.getUTCDate(),
    now.getUTCMonth() + 1,
    now.getUTCDay(),
  ];
  return fields.length === 5 && fields.every((field, i) => fieldMatches(field, values[i]!));
}

export async function tick(
  now: Date,
  env: StoreEnv,
  registered: readonly Job[] = jobs,
): Promise<void> {
  for (const job of registered) {
    if (!due(job.schedule, now)) continue;
    try {
      await job.run(now, env);
    } catch (error) {
      console.error(`tick ${job.name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
