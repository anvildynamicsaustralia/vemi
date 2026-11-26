/**
 * Moving into a copy the person already has (move-to-cloud, Task 7). One plain `fetch` to that
 * copy's own `/setup/move` with a move code the copy made (Task 4) and the export document:
 * no middleman, no cookie, no referrer. Without `confirm` the copy only counts; with it, it
 * replaces what it holds. Every stop is one sentence.
 */
import { moveAddress } from "../shared/setup/getFlow.js";

export const NOT_VEMI = "That address is not a VEMI copy.";
export const OTHER_VERSION = "That copy is at another version of VEMI.";
export const DOOR_SHUT = "That copy did not answer, or its door is shut to a move from here.";
export const BAD_CODE = "That copy did not take the move code. Make a new one there.";
const TOO_BIG = "That file is too big to move in one go.";
const REFUSED = "That copy would not take that. Try again.";

export type CopyAnswer =
  | { readonly ok: true; readonly counts: Readonly<Record<string, number>>; readonly holds: Readonly<Record<string, number>> }
  | { readonly ok: false; readonly reason: string };

/** The origin of an https address, or null for anything else. */
export function copyOrigin(text: string): string | null {
  try {
    const url = new URL(text.trim());
    return url.protocol === "https:" && url.hostname !== "" ? url.origin : null;
  } catch {
    return null;
  }
}

/** How many rows each table of an export holds. */
export function tableCounts(document: Readonly<Record<string, unknown>>): Record<string, number> {
  const tables = document["tables"];
  if (typeof tables !== "object" || tables === null || Array.isArray(tables)) return {};
  const out: Record<string, number> = {};
  for (const [name, rows] of Object.entries(tables)) out[name] = Array.isArray(rows) ? rows.length : 0;
  return out;
}

const record = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

const numbers = (value: unknown): Record<string, number> | null => {
  const found = record(value);
  if (found === null) return null;
  const out: Record<string, number> = {};
  for (const [name, n] of Object.entries(found)) if (typeof n === "number") out[name] = n;
  return out;
};

export async function askCopy(input: {
  readonly address: string;
  readonly code: string;
  readonly document: Readonly<Record<string, unknown>>;
  readonly confirm: boolean;
  readonly fetch?: typeof fetch;
}): Promise<CopyAnswer> {
  const origin = copyOrigin(input.address);
  if (origin === null) return { ok: false, reason: NOT_VEMI };
  const doFetch = input.fetch ?? ((url: RequestInfo | URL, init?: RequestInit) => fetch(url, init));
  const body = JSON.stringify({ code: input.code, document: input.document, ...(input.confirm ? { confirm: "replace" } : {}) });

  let response: Response;
  try {
    response = await doFetch(moveAddress(origin), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      credentials: "omit",
      referrerPolicy: "no-referrer",
    });
  } catch {
    // A shut door and an address that goes nowhere look the same to a browser: it reads no answer.
    return { ok: false, reason: DOOR_SHUT };
  }

  let answer: unknown = null;
  try {
    answer = await response.json();
  } catch {
    return { ok: false, reason: NOT_VEMI };
  }
  const said = record(answer)?.["error"];

  if (!response.ok) {
    if (response.status === 403) return { ok: false, reason: BAD_CODE };
    if (response.status === 413) return { ok: false, reason: TOO_BIG };
    // An older copy answers any path it does not know with a JSON 404.
    if (response.status === 404 || response.status === 405) return { ok: false, reason: OTHER_VERSION };
    if (typeof said === "string" && /version|format/i.test(said)) return { ok: false, reason: OTHER_VERSION };
    return { ok: false, reason: typeof said === "string" && said !== "" && said.length <= 200 ? said : REFUSED };
  }

  const counts = numbers(record(answer)?.["counts"]);
  if (counts === null) return { ok: false, reason: NOT_VEMI };
  return { ok: true, counts, holds: numbers(record(answer)?.["holds"]) ?? {} };
}
