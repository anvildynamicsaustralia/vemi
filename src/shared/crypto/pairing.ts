import { type Bytes, aesKeyFrom, fromBase64Url, hkdf, randomBytes, toBase64Url, utf8 } from "./bytes.js";
import { ACCOUNT_KEY_BYTES } from "./accountKey.js";
import { CryptoError } from "./envelope.js";

/**
 * Pairing a new device. The new device makes an ECDH P-256 pair and shows the public half
 * (in a QR or link fragment, never to the server). A device that holds the key seals one copy
 * to it: ephemeral ECDH, then HKDF, then AES-GCM with the pairing id as additional data.
 */

const IV_BYTES = 12;
const POINT_BYTES = 65;

/** The Worker typings spell the ECDH `public` member differently from the DOM ones; the runtime name is `public`. */
type DeriveAlgorithm = Parameters<SubtleCrypto["deriveBits"]>[0];

export async function pairingKeys(): Promise<CryptoKeyPair> {
  const keys = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
  return keys as CryptoKeyPair;
}

async function rawPublic(key: CryptoKey): Promise<Uint8Array> {
  return new Uint8Array((await crypto.subtle.exportKey("raw", key)) as ArrayBuffer);
}

/** The public half as the raw uncompressed point, base64url. */
export async function pairingPublic(keys: CryptoKeyPair): Promise<string> {
  return toBase64Url(await rawPublic(keys.publicKey));
}

function importPublic(raw: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", raw as Bytes, { name: "ECDH", namedCurve: "P-256" }, true, []);
}

function label(pairingId: string): string {
  return `vemi:pairing:v1:${pairingId}`;
}

async function sharedKey(secret: CryptoKey, publicKey: CryptoKey, pairingId: string): Promise<CryptoKey> {
  const algorithm = { name: "ECDH", public: publicKey } as unknown as DeriveAlgorithm;
  const bits = new Uint8Array(await crypto.subtle.deriveBits(algorithm, secret, 256));
  return aesKeyFrom(await hkdf(bits, label(pairingId), 32));
}

/** Returns `ephemeralPublic.iv.ciphertext`, base64url. */
export async function sealForPairing(
  accountKey: Uint8Array,
  theirPublic: string,
  pairingId: string,
): Promise<string> {
  const raw = fromBase64Url(theirPublic);
  if (!raw || raw.length !== POINT_BYTES) throw new CryptoError("damaged");
  let their: CryptoKey;
  try {
    their = await importPublic(raw);
  } catch {
    throw new CryptoError("damaged");
  }
  const ours = await pairingKeys();
  const key = await sharedKey(ours.privateKey, their, pairingId);
  const iv = randomBytes(IV_BYTES);
  const data = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: utf8(label(pairingId)) },
    key,
    accountKey as Bytes,
  );
  return [toBase64Url(await rawPublic(ours.publicKey)), toBase64Url(iv), toBase64Url(new Uint8Array(data))].join(".");
}

/** Opens the sealed copy on the new device. A wrong pairing id or key pair is refused. */
export async function openFromPairing(keys: CryptoKeyPair, sealed: string, pairingId: string): Promise<Bytes> {
  const parts = sealed.split(".");
  const ephemeral = parts.length === 3 ? fromBase64Url(parts[0] ?? "") : null;
  const iv = parts.length === 3 ? fromBase64Url(parts[1] ?? "") : null;
  const data = parts.length === 3 ? fromBase64Url(parts[2] ?? "") : null;
  if (!ephemeral || ephemeral.length !== POINT_BYTES || !iv || iv.length !== IV_BYTES || !data) {
    throw new CryptoError("damaged");
  }
  let plain: Uint8Array;
  try {
    const key = await sharedKey(keys.privateKey, await importPublic(ephemeral), pairingId);
    plain = new Uint8Array(
      await crypto.subtle.decrypt({ name: "AES-GCM", iv, additionalData: utf8(label(pairingId)) }, key, data),
    );
  } catch {
    throw new CryptoError("binding");
  }
  if (plain.length !== ACCOUNT_KEY_BYTES) throw new CryptoError("damaged");
  return plain as Bytes;
}
