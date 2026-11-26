import { type Bytes, aesKeyFrom, fromBase64Url, hkdf, randomBytes, toBase64Url, utf8 } from "./bytes.js";
import { ACCOUNT_KEY_BYTES } from "./accountKey.js";
import { CryptoError } from "./envelope.js";

/** The three ways a copy of the account key is kept on the server. */
export type WrapKind = "passkey" | "password" | "recovery";

const IV_BYTES = 12;

function aad(kind: WrapKind, keyRef: string): Bytes {
  return utf8(`vemi:wrap:v1:${kind}:${keyRef}`);
}

/** A wrapping key from what a passkey returned for the PRF extension. */
export async function passkeyWrappingKey(prfOutput: Uint8Array): Promise<CryptoKey> {
  return aesKeyFrom(await hkdf(prfOutput, "vemi:wrapping-key:passkey:v1", 32));
}

/** Encrypts the account key. The result is `iv.ciphertext`, base64url, ready for the server. */
export async function wrapKey(
  wrappingKey: CryptoKey,
  accountKey: Uint8Array,
  kind: WrapKind,
  keyRef: string,
): Promise<string> {
  const iv = randomBytes(IV_BYTES);
  const data = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: aad(kind, keyRef) },
    wrappingKey,
    accountKey as Bytes,
  );
  return `${toBase64Url(iv)}.${toBase64Url(new Uint8Array(data))}`;
}

/** Opens a wrapped copy. A wrong way in, kind or key ref is refused with reason `key`. */
export async function unwrapKey(
  wrappingKey: CryptoKey,
  wrapped: string,
  kind: WrapKind,
  keyRef: string,
): Promise<Bytes> {
  const parts = wrapped.split(".");
  const iv = parts.length === 2 ? fromBase64Url(parts[0] ?? "") : null;
  const data = parts.length === 2 ? fromBase64Url(parts[1] ?? "") : null;
  if (!iv || iv.length !== IV_BYTES || !data) throw new CryptoError("damaged");
  let plain: Uint8Array;
  try {
    plain = new Uint8Array(
      await crypto.subtle.decrypt({ name: "AES-GCM", iv, additionalData: aad(kind, keyRef) }, wrappingKey, data),
    );
  } catch {
    throw new CryptoError("key");
  }
  if (plain.length !== ACCOUNT_KEY_BYTES) throw new CryptoError("damaged");
  return plain as Bytes;
}
