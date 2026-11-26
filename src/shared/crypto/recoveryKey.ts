import { type Bytes, aesKeyFrom, hkdf, randomBytes } from "./bytes.js";
import { CryptoError } from "./envelope.js";

/**
 * The recovery key: 32 random bytes written as Crockford base32 in groups of 4 (13 groups)
 * and one checksum group from SHA-256, so a typo is caught before any unwrap.
 */

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const KEY_BYTES = 32;
const KEY_CHARS = 52;
const CHECK_CHARS = 4;

export function makeRecoveryKey(): Bytes {
  return randomBytes(KEY_BYTES);
}

function encode(bytes: Uint8Array, chars: number): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >> (bits - 5)) & 31];
      bits -= 5;
    }
    value &= (1 << bits) - 1;
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out.slice(0, chars);
}

async function checksum(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as Bytes));
  return encode(digest.slice(0, 3), CHECK_CHARS);
}

export async function formatRecoveryKey(bytes: Uint8Array): Promise<string> {
  if (bytes.length !== KEY_BYTES) throw new RangeError("A recovery key is 32 bytes.");
  const text = encode(bytes, KEY_CHARS) + (await checksum(bytes));
  return (text.match(/.{4}/g) ?? []).join("-");
}

/** Reads what a person typed back. Anything that is not one exact key is refused as damaged. */
export async function parseRecoveryKey(text: string): Promise<Bytes> {
  const clean = text
    .toUpperCase()
    .replace(/[\s-]+/g, "")
    .replace(/[IL]/g, "1")
    .replace(/O/g, "0");
  if (clean.length !== KEY_CHARS + CHECK_CHARS) throw new CryptoError("damaged");
  const out = new Uint8Array(KEY_BYTES);
  let bits = 0;
  let value = 0;
  let at = 0;
  for (const char of clean.slice(0, KEY_CHARS)) {
    const digit = ALPHABET.indexOf(char);
    if (digit < 0) throw new CryptoError("damaged");
    value = (value << 5) | digit;
    bits += 5;
    if (bits >= 8) {
      out[at] = (value >> (bits - 8)) & 255;
      at += 1;
      bits -= 8;
      value &= (1 << bits) - 1;
    }
  }
  // The last character carries 4 unused bits; they must be zero.
  if (value !== 0) throw new CryptoError("damaged");
  if ((await checksum(out)) !== clean.slice(KEY_CHARS)) throw new CryptoError("damaged");
  return out;
}

export async function recoveryWrappingKey(bytes: Uint8Array): Promise<CryptoKey> {
  return aesKeyFrom(await hkdf(bytes, "vemi:wrapping-key:recovery:v1", 32));
}
