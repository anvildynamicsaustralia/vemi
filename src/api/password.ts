/*
 * Passwords: salted PBKDF2-SHA-256 through WebCrypto, nothing else.
 *
 * Pure. No store, no request. The stored form is
 * `pbkdf2-sha256$<count>$<salt b64url>$<hash b64url>`, so the count travels
 * with the hash and a later bump re-hashes on the next good sign-in
 * (`needsRehash`). Rule failures return false or a sentence; nothing here
 * throws on a stored value it cannot read.
 */
import { PASSWORD_MAX, PASSWORD_MIN, passwordLength } from "@vemi/shared";

// Cloudflare Workers caps PBKDF2 at 100000 iterations in production. Local
// workerd does not enforce the cap, so a higher number would pass every test
// here and fail on deploy. Keep it at the cap.
export const PBKDF2_ITERATIONS = 100000;

const SCHEME = "pbkdf2-sha256";
const SALT_BYTES = 16;
const HASH_BYTES = 32;

// A fixed salt for dummyVerify to work against.
const DUMMY_SALT = new Uint8Array(SALT_BYTES).fill(7);

function encode(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function decode(text: string): Uint8Array<ArrayBuffer> | null {
  if (!/^[A-Za-z0-9_-]+$/.test(text)) return null;
  try {
    const binary = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

async function derive(
  pw: string,
  salt: Uint8Array<ArrayBuffer>,
  iterations: number,
): Promise<Uint8Array<ArrayBuffer>> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(pw.normalize("NFC")),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations },
    key,
    HASH_BYTES * 8,
  );
  return new Uint8Array(bits);
}

// Equal length first, then a comparison that does not stop at the first
// difference. workerd has crypto.subtle.timingSafeEqual; Node (where the tests
// run) does not, so the same-shaped loop stands in for it there.
function sameBytes(a: Uint8Array<ArrayBuffer>, b: Uint8Array<ArrayBuffer>): boolean {
  if (a.byteLength !== b.byteLength) return false;
  const subtle = crypto.subtle as SubtleCrypto & {
    timingSafeEqual?: (x: ArrayBufferView, y: ArrayBufferView) => boolean;
  };
  if (typeof subtle.timingSafeEqual === "function") return subtle.timingSafeEqual(a, b);
  let diff = 0;
  for (let i = 0; i < a.byteLength; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

type Parts = { iterations: number; salt: Uint8Array<ArrayBuffer>; hash: Uint8Array<ArrayBuffer> };

function parse(stored: string): Parts | null {
  const parts = stored.split("$");
  if (parts.length !== 4 || parts[0] !== SCHEME) return null;
  const [, count, saltText, hashText] = parts as [string, string, string, string];
  if (!/^[1-9][0-9]{0,9}$/.test(count)) return null;
  const salt = decode(saltText);
  const hash = decode(hashText);
  if (!salt || !hash) return null;
  return { iterations: Number(count), salt, hash };
}

export async function hashPassword(pw: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const hash = await derive(pw, salt, PBKDF2_ITERATIONS);
  return `${SCHEME}$${PBKDF2_ITERATIONS}$${encode(salt)}$${encode(hash)}`;
}

export async function verifyPassword(pw: string, stored: string): Promise<boolean> {
  try {
    const parts = parse(stored);
    if (!parts) return false;
    const got = await derive(pw, parts.salt, parts.iterations);
    return sameBytes(got, parts.hash);
  } catch {
    return false;
  }
}

export function needsRehash(stored: string): boolean {
  const parts = parse(stored);
  return !parts || parts.iterations !== PBKDF2_ITERATIONS;
}

// When no account matches, do the same work a real check does so the reply
// takes the same time. Always false.
export async function dummyVerify(pw: string): Promise<boolean> {
  await derive(pw, DUMMY_SALT, PBKDF2_ITERATIONS);
  return false;
}

export function passwordProblem(pw: string): string | null {
  const length = passwordLength(pw);
  if (length < PASSWORD_MIN) return `Use at least ${PASSWORD_MIN} characters.`;
  if (length > PASSWORD_MAX) return `Use at most ${PASSWORD_MAX} characters.`;
  return null;
}
