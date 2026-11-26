/**
 * The secret a session cookie is signed with. A copy starts with none set: `SESSION_SECRET`
 * wins when it is, else a key made on first use and kept in D1 through the store, so a
 * session signed before a restart still verifies after it. Two Workers racing on a fresh
 * database end on one key, because the store keeps the first and answers it to both.
 */

import type { Store } from "./store.js";
import { toBase64Url } from "./vapid.js";

/** 32 random bytes, base64url. */
export function makeSessionKey(): string {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
}

/** The secret in force: the set one, else the kept one, made now if this is the first call. */
export async function sessionKey(store: Store, secret?: string | undefined): Promise<string> {
  if (secret) return secret;
  const kept = await store.sessionKey();
  if (kept !== null) return kept;
  return store.keepSessionKey(makeSessionKey());
}

/**
 * The address this copy answers at: `ORIGIN` when set, else the origin of the request that
 * started it (a copy's own address is not known before its first request).
 */
export function copyOrigin(configured: string | undefined, request: Request): string {
  return configured ? configured : new URL(request.url).origin;
}
