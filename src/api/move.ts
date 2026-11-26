/**
 * The rules of a move, pure. `/setup/move` asks here; nothing in this file reads a store.
 *
 * CORS is the exact origin the copy was built for and no other. It does not close once the
 * copy has an owner: that is the difference from `/setup/claim`.
 */
import { sameCode } from "./setup.js";
import { capBody, type Capped } from "./body.js";

export type { Capped };

/** The most a move will read: 20 MB. */
export const MOVE_LIMIT = 20 * 1024 * 1024;

/** The body as text, or a 413 when it runs past `limit` bytes. A false length header does not help. */
export const capBytes = (request: Request, limit: number = MOVE_LIMIT): Promise<Capped> =>
  capBody(request, limit, "That file is too big to move in one go.");

/** The headers a browser needs to call from the one configured origin; nothing for any other. */
export function moveCors(asked: string | null, configured: string): Record<string, string> {
  if (configured === "" || configured === "*" || configured === "null" || asked === null || asked !== configured) return {};
  return {
    "access-control-allow-origin": configured,
    "access-control-allow-methods": "POST, OPTIONS",
    "access-control-allow-headers": "content-type",
    vary: "origin",
  };
}

/** How long a code an account makes stays good: 15 minutes. */
export const MOVE_CODE_MS = 15 * 60 * 1000;

const CODE_LETTERS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/** A fresh code of 100 random bits, in five groups of four so it can be read out and typed. */
export function newMoveCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(20));
  const letters = Array.from(bytes, (b) => CODE_LETTERS[b & 31]).join("");
  return letters.match(/.{4}/g)!.join("-");
}

/** What the store keeps for a code: the SHA-256 of its letters, whatever case or dashes it was typed with. */
export async function moveCodeId(given: string): Promise<string> {
  const letters = given.toUpperCase().replace(/[^A-Z2-9]/g, "");
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(letters)));
  return Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Whether what a caller sent is the copy's code: a string, compared in constant time. */
export async function moveCodeOk(given: unknown, expected: string): Promise<boolean> {
  return typeof given === "string" && (await sameCode(given, expected));
}
