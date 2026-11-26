import { type Bytes, aesKeyFrom, equalBytes, fromBase64Url, hkdf, randomBytes, toBase64Url } from "./bytes.js";

export const ACCOUNT_KEY_BYTES = 32;

/** What a device derives from the account key. Only `fieldKey` stays on the device. */
export interface DerivedKeys {
  /** AES-GCM 256, not exportable. Seals and opens envelopes. */
  fieldKey: CryptoKey;
  /** 16 bytes, base64url. Stored on the server so a device can confirm it holds the right key. */
  keyCheck: string;
  /** 8 bytes, base64url. Public. Names which account key an envelope or wrapping belongs to. */
  keyRef: string;
}

const FIELD_LABEL = "vemi:field-key:v1";
const CHECK_LABEL = "vemi:key-check:v1";
const REF_LABEL = "vemi:key-ref:v1";

/** 32 random bytes, made on the device and never sent anywhere unwrapped. */
export function makeAccountKey(): Bytes {
  return randomBytes(ACCOUNT_KEY_BYTES);
}

export async function keysFrom(accountKey: Uint8Array): Promise<DerivedKeys> {
  if (accountKey.length !== ACCOUNT_KEY_BYTES) throw new RangeError("An account key is 32 bytes.");
  const [field, check, ref] = await Promise.all([
    hkdf(accountKey, FIELD_LABEL, 32),
    hkdf(accountKey, CHECK_LABEL, 16),
    hkdf(accountKey, REF_LABEL, 8),
  ]);
  return { fieldKey: await aesKeyFrom(field), keyCheck: toBase64Url(check), keyRef: toBase64Url(ref) };
}

/** True when this account key is the one the stored key check was made from. */
export async function sameKey(accountKey: Uint8Array, keyCheck: string): Promise<boolean> {
  const stored = fromBase64Url(keyCheck);
  if (!stored || accountKey.length !== ACCOUNT_KEY_BYTES) return false;
  return equalBytes(await hkdf(accountKey, CHECK_LABEL, 16), stored);
}
