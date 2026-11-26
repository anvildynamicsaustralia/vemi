/**
 * The hand-over (ruling R3): the page posts the claim code, and the key when the copy is to keep
 * itself up to date, straight to the new copy's `/setup/claim`. The copy answers this page's
 * origin and no other, once. With the switch off the key is not sent at all.
 */
import { claimAddress } from "../../shared/setup/getFlow.js";

export type HandOver = { ok: true } | { ok: false; reason: string };

export interface HandOverInput {
  /** The new copy's address. */
  address: string;
  code: string;
  /** The key, sent only when `keepUpdated`. */
  token: string;
  keepUpdated: boolean;
  fetch?: typeof fetch;
  /** Waits between tries; replaced in tests. */
  wait?: (ms: number) => Promise<void>;
}

/** A new address can take a moment to answer. Tried this many times, this far apart. */
export const TRIES = 8;
export const TRY_GAP_MS = 2500;

const REFUSED = "The new copy did not take the hand-over. Try again, or start the setup again.";
const UNREACHED = "The new copy is not answering yet. Try again in a minute.";

export async function handOver(input: HandOverInput): Promise<HandOver> {
  const doFetch = input.fetch ?? ((url: RequestInfo | URL, init?: RequestInit) => fetch(url, init));
  const wait = input.wait ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const body = JSON.stringify(input.keepUpdated ? { code: input.code, token: input.token, keepUpdated: true } : { code: input.code, keepUpdated: false });

  for (let attempt = 0; attempt < TRIES; attempt++) {
    if (attempt > 0) await wait(TRY_GAP_MS);
    let response: Response;
    try {
      response = await doFetch(claimAddress(input.address), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
        credentials: "omit",
        referrerPolicy: "no-referrer",
      });
    } catch {
      continue;
    }
    if (response.ok) return { ok: true };
    // A copy that is still starting answers with an error page; a refusal is final.
    if (response.status === 403 || response.status === 409 || response.status === 400) return { ok: false, reason: REFUSED };
  }
  return { ok: false, reason: UNREACHED };
}
