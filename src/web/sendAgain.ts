/**
 * Whether a write that failed is worth sending again.
 *
 * Decision 20's fields travel whole — the checklist and tags are patched as one value, not as
 * one step each — so a failed write leaves what was typed on screen while the Worker still
 * holds the value before it. Andy's call: **hold what was typed and offer to send it again**,
 * rather than rolling it back and losing it. This says which failures that offer makes sense
 * for, because an offer that cannot work is worse than none.
 *
 * A refusal is the Worker having read the write and said no: a name already taken, a thing
 * that is gone, a field that is not an id. Sending the same bytes again gets the same answer,
 * so there is no offer to make. Anything else — the Worker erroring, a connection that broke
 * mid-flight — is the write not having been answered, and is worth another go.
 *
 * A write made with no connection at all never reaches here: the outbox keeps it and says so.
 */
import { ApiError } from "./api.js";

export function worthSendingAgain(err: unknown): boolean {
  if (err instanceof ApiError) return err.status === 0 || err.status >= 500;
  return true;
}
