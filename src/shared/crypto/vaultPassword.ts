import { type Bytes, aesKeyFrom, randomBytes, utf8 } from "./bytes.js";

// Derives the vault key from the vault password. This is not the sign-in mechanism:
// sign-in lives in the API files; this one only wraps the account key on the device.

/** OWASP Password Storage Cheat Sheet, read 19 Nov 2026: 600,000 for this hash. */
export const VAULT_ITERATIONS = 600_000;
export const VAULT_SALT_BYTES = 16;

export function makeVaultSalt(): Bytes {
  return randomBytes(VAULT_SALT_BYTES);
}

/** Salt and iterations are stored beside the wrapped copy, so the count can rise later. */
export async function passwordWrappingKey(
  password: string,
  salt: Uint8Array,
  iterations: number = VAULT_ITERATIONS,
): Promise<CryptoKey> {
  if (!Number.isInteger(iterations) || iterations < 1) throw new RangeError("Iterations must be a whole number.");
  const base = await crypto.subtle.importKey("raw", utf8(password.normalize("NFKC")), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: salt as Bytes, iterations },
    base,
    256,
  );
  return aesKeyFrom(new Uint8Array(bits));
}
