/**
 * The key pair this copy signs push messages with (RFC 8292, VAPID). A browser's push service
 * only accepts a message signed by the same key the device subscribed with, so the pair has
 * to stay put. It is made once, on first use, and kept in D1 through the store; setting both
 * `VAPID_PUBLIC` and `VAPID_PRIVATE` as secrets replaces it, for a copy that wants to hold its
 * own. Both are base64url: the 65 byte uncompressed public point and the 32 byte private
 * scalar. Nothing here calls a push service; sending is a later task.
 */

import type { Store, StoredVapidKey } from "./store.js";

/** The two optional secrets. Both or neither: one alone is ignored. */
export interface VapidSecrets {
  readonly publicKey?: string | undefined;
  readonly privateKey?: string | undefined;
}

export function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromBase64Url(text: string): Uint8Array {
  const padded = text.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(text.length / 4) * 4, "=");
  return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
}

/** A new P-256 pair, as the two base64url strings the store keeps. */
export async function makeVapidKey(): Promise<StoredVapidKey> {
  const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const jwk = (await crypto.subtle.exportKey("jwk", pair.privateKey)) as JsonWebKey;
  if (jwk.x === undefined || jwk.y === undefined || jwk.d === undefined) throw new Error("the key pair has no coordinates");
  const point = new Uint8Array(65);
  point[0] = 4;
  point.set(fromBase64Url(jwk.x), 1);
  point.set(fromBase64Url(jwk.y), 33);
  return { publicKey: toBase64Url(point), privateKey: jwk.d };
}

/** The signing key, for the task that sends. */
export async function importVapidSigningKey(key: StoredVapidKey): Promise<CryptoKey> {
  const point = fromBase64Url(key.publicKey);
  return crypto.subtle.importKey(
    "jwk",
    { kty: "EC", crv: "P-256", x: toBase64Url(point.slice(1, 33)), y: toBase64Url(point.slice(33, 65)), d: key.privateKey },
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
}

/**
 * The pair in force: the secrets when both are set, else the one kept in D1, made now if this
 * is the first call. Two calls racing to make it end up with the same pair, because the store
 * keeps the first and answers it to both.
 */
export async function vapidKeys(store: Store, secrets: VapidSecrets = {}): Promise<StoredVapidKey> {
  if (secrets.publicKey && secrets.privateKey) return { publicKey: secrets.publicKey, privateKey: secrets.privateKey };
  const kept = await store.vapidKey();
  if (kept !== null) return kept;
  return store.keepVapidKey(await makeVapidKey());
}
