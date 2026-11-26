/**
 * The four update writes: `POST /api/update/start`, `/step`, `/back` and `/off`. Owner only, and
 * writes, so the handler has already held the request to the copy's own Origin. `start` and `step`
 * answer `{ step, done, remaining, progress }`; `back` deploys the version the copy ran before;
 * `off` takes `{ confirm: "off" }` and deletes the copy's sealed key. Each answers `{ error }` with a
 * sentence when it refuses. A copy with no way to update itself (no `SETUP_CLAIM`, so no sealed key)
 * answers 409.
 */
import type { SelfUpdate, UpdateAnswer } from "./selfUpdate.js";
import { parseOff } from "./validate.js";

export const NO_UPDATER = "This copy kept no key to update itself with.";

export interface UpdateRouteDeps {
  readonly update?: SelfUpdate;
  readonly copyOwner?: string;
}

const ACTIONS = ["start", "step", "back", "off"];

/**
 * Answers the update writes, or null for any other path under `/api/update`. `body` is the parsed JSON
 * the request sent; only `off` reads it.
 */
export async function updateRoute(
  deps: UpdateRouteDeps, owner: string, method: string, action: string | undefined, body?: unknown,
): Promise<UpdateAnswer | null> {
  if (action === undefined || !ACTIONS.includes(action)) return null;
  if (method !== "POST") return { status: 405, body: { error: `POST update/${action}` } };
  if (deps.copyOwner === undefined || deps.copyOwner === "" || deps.copyOwner !== owner) {
    return { status: 403, body: { error: "Only the owner can do this." } };
  }
  if (deps.update === undefined) return { status: 409, body: { error: NO_UPDATER } };
  if (action === "off") {
    const asked = parseOff(body);
    return asked.ok ? deps.update.off() : { status: 400, body: { error: asked.error } };
  }
  if (action === "back") return deps.update.back();
  return action === "start" ? deps.update.start() : deps.update.step();
}
