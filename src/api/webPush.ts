/**
 * Sending one push message with nothing but WebCrypto: the body is encrypted for the device
 * with aes128gcm (RFC 8291, over RFC 8188) and the request is signed with VAPID (RFC 8292,
 * ES256), so the browser's push service accepts it. There is no library to keep up to date.
 * The Worker calls the device's endpoint with `fetch`; nothing here touches D1.
 */

import type { PushPayload } from "@vemi/shared";
import { fromBase64Url, importVapidSigningKey, toBase64Url } from "./vapid.js";

/** What a device gave when it subscribed: its endpoint and the two keys, base64url. */
export interface PushTarget {
  readonly endpoint: string;
  readonly p256dh: string;
  readonly auth: string;
}

/** The signing pair and who is asking: `subject` is the copy's own address (`ORIGIN`). */
export interface PushVapid {
  readonly publicKey: string;
  readonly privateKey: string;
  readonly subject: string;
}

export type PushResult =
  | { readonly kind: "sent" }
  | { readonly kind: "gone" }
  | { readonly kind: "failed"; readonly status: number | null };

/** An ephemeral sender key and salt, fixed only by the RFC's own test vector. */
export interface Ephemeral {
  readonly salt: Uint8Array;
  /** The 65 byte uncompressed public point. */
  readonly publicKey: Uint8Array;
  /** The private scalar, base64url. */
  readonly privateKey: string;
}

const RECORD_SIZE = 4096;
const MAX_LEAD_SECONDS = 12 * 3600;
const text = (s: string) => new TextEncoder().encode(s);

function join(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

async function hkdf(ikm: BufferSource, salt: Uint8Array, info: Uint8Array, bits: number): Promise<ArrayBuffer> {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, bits);
}

async function freshEphemeral(): Promise<Ephemeral> {
  const pair = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair;
  const jwk = (await crypto.subtle.exportKey("jwk", pair.privateKey)) as JsonWebKey;
  const publicKey = new Uint8Array((await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer);
  if (jwk.d === undefined) throw new Error("the sender key has no private part");
  return { salt: crypto.getRandomValues(new Uint8Array(16)), publicKey, privateKey: jwk.d };
}

/**
 * The aes128gcm body for one device: header (salt, record size, key id = sender public key)
 * then a single record holding the plaintext, a 0x02 delimiter and the GCM tag. One record
 * is enough, the plaintext stays far below the 4096 byte record.
 */
export async function encryptAes128gcm(
  plaintext: Uint8Array,
  uaPublic: Uint8Array,
  authSecret: Uint8Array,
  ephemeral?: Ephemeral,
): Promise<Uint8Array> {
  const as = ephemeral ?? (await freshEphemeral());
  if (plaintext.length > RECORD_SIZE - 17 - 1) throw new Error("the message is too long for one record");
  const curve = { name: "ECDH", namedCurve: "P-256" } as const;
  const device = await crypto.subtle.importKey("raw", uaPublic, curve, false, []);
  const mine = await crypto.subtle.importKey(
    "jwk",
    { kty: "EC", crv: "P-256", x: toBase64Url(as.publicKey.slice(1, 33)), y: toBase64Url(as.publicKey.slice(33, 65)), d: as.privateKey },
    curve,
    false,
    ["deriveBits"],
  );
  const shared = await crypto.subtle.deriveBits({ name: "ECDH", public: device } as unknown as SubtleCryptoDeriveKeyAlgorithm, mine, 256);
  const keyInfo = join(text("WebPush: info\0"), uaPublic, as.publicKey);
  const ikm = await hkdf(shared, authSecret, keyInfo, 256);
  const cek = await hkdf(ikm, as.salt, text("Content-Encoding: aes128gcm\0"), 128);
  const nonce = await hkdf(ikm, as.salt, text("Content-Encoding: nonce\0"), 96);
  const aes = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const record = await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, aes, join(plaintext, new Uint8Array([2])));
  const header = new Uint8Array(21);
  header.set(as.salt, 0);
  new DataView(header.buffer).setUint32(16, RECORD_SIZE, false);
  header[20] = as.publicKey.length;
  return join(header, as.publicKey, new Uint8Array(record));
}

/** The `Authorization` header value (RFC 8292): a signed token naming the push service. */
export async function vapidAuthorization(endpoint: string, vapid: PushVapid, now: Date): Promise<string> {
  const claims = { aud: new URL(endpoint).origin, exp: Math.floor(now.getTime() / 1000) + MAX_LEAD_SECONDS, sub: vapid.subject };
  const signing = `${toBase64Url(text(JSON.stringify({ typ: "JWT", alg: "ES256" })))}.${toBase64Url(text(JSON.stringify(claims)))}`;
  const key = await importVapidSigningKey({ publicKey: vapid.publicKey, privateKey: vapid.privateKey });
  const signature = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, text(signing)));
  return `vapid t=${signing}.${toBase64Url(signature)}, k=${vapid.publicKey}`;
}

/** How long a push service has to answer before the device is counted as failed this minute. */
export const PUSH_DEADLINE_MS = 8_000;

/**
 * Send one message to one device. `gone` means the push service forgot the device (404 or
 * 410), so the caller can drop it; anything else that is not a success is `failed`, with the
 * status when there was one and null when the request itself threw.
 */
export async function sendPush(
  target: PushTarget,
  payload: PushPayload,
  vapid: PushVapid,
  now: Date,
  post: typeof fetch = fetch,
  deadlineMs: number = PUSH_DEADLINE_MS,
): Promise<PushResult> {
  try {
    const body = await encryptAes128gcm(text(JSON.stringify(payload)), fromBase64Url(target.p256dh), fromBase64Url(target.auth));
    const response = await post(target.endpoint, {
      method: "POST",
      headers: {
        Authorization: await vapidAuthorization(target.endpoint, vapid, now),
        "Content-Encoding": "aes128gcm",
        "Content-Type": "application/octet-stream",
        TTL: "86400",
        Urgency: payload.kind === "task" ? "high" : "normal",
      },
      body,
      // A push service that stalls must not hold the minute's tick, nor one that redirects somewhere else.
      signal: AbortSignal.timeout(deadlineMs),
      redirect: "error",
    });
    // Nothing of the answer is read, so the connection is let go.
    await response.body?.cancel().catch(() => {});
    if (response.status >= 200 && response.status < 300) return { kind: "sent" };
    if (response.status === 404 || response.status === 410) return { kind: "gone" };
    return { kind: "failed", status: response.status };
  } catch {
    return { kind: "failed", status: null };
  }
}
