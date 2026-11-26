// Time-based codes (RFC 6238) and one-time codes, on WebCrypto only, so a person can
// sign in with an authenticator app and fall back to codes they keep. Pure: no store.

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const STEP_SECONDS = 30;
const DIGITS = 6;

export function base32Encode(bytes: Uint8Array): string {
  let out = "";
  let bits = 0;
  let value = 0;
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
    value &= (1 << bits) - 1;
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

// Any case; spaces, dashes and trailing "=" are ignored. Null for anything else.
export function base32Decode(text: string): Uint8Array | null {
  const clean = text.toUpperCase().replace(/[\s-]/g, "").replace(/=+$/, "");
  const out: number[] = [];
  let bits = 0;
  let value = 0;
  for (const ch of clean) {
    const at = ALPHABET.indexOf(ch);
    if (at < 0) return null;
    value = (value << 5) | at;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
      value &= (1 << bits) - 1;
    }
  }
  return Uint8Array.from(out);
}

async function hotp(secret: Uint8Array, counter: number): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    secret,
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"],
  );
  const message = new DataView(new ArrayBuffer(8));
  message.setUint32(0, Math.floor(counter / 2 ** 32));
  message.setUint32(4, counter >>> 0);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, message.buffer));
  const offset = mac[mac.length - 1]! & 15;
  const binary =
    ((mac[offset]! & 127) << 24) |
    (mac[offset + 1]! << 16) |
    (mac[offset + 2]! << 8) |
    mac[offset + 3]!;
  return String(binary % 10 ** DIGITS).padStart(DIGITS, "0");
}

const stepOf = (at: number) => Math.floor(at / 1000 / STEP_SECONDS);

// The six-digit code for the 30 s step holding `at` (milliseconds).
export function totp(secret: Uint8Array, at: number): Promise<string> {
  return hotp(secret, stepOf(at));
}

function sameText(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// Accepts the current step and one either side, for a slow clock or a slow thumb. Answers the
// 30 s step the code belongs to, or null when it matches none, so a caller can refuse a replay.
export async function matchTotpStep(secret: Uint8Array, code: string, at: number): Promise<number | null> {
  const typed = code.replace(/\s/g, "");
  if (!/^[0-9]{6}$/.test(typed)) return null;
  const step = stepOf(at);
  let found: number | null = null;
  for (const delta of [-1, 0, 1]) {
    if (step + delta < 0) continue;
    if (sameText(await hotp(secret, step + delta), typed)) found = step + delta;
  }
  return found;
}

export async function verifyTotp(secret: Uint8Array, code: string, at: number): Promise<boolean> {
  return (await matchTotpStep(secret, code, at)) !== null;
}

export function otpauthUri(label: string, secret: Uint8Array, issuer = "VEMI"): string {
  const name = `${encodeURIComponent(issuer)}:${encodeURIComponent(label)}`;
  return `otpauth://totp/${name}?secret=${base32Encode(secret)}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=${DIGITS}&period=${STEP_SECONDS}`;
}

// Upper case, letters and digits only, so a code typed with a space or no dash still matches.
export async function hashCode(code: string): Promise<string> {
  const clean = code.toUpperCase().replace(/[^A-Z0-9]/g, "");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(clean));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export type OneTimeCode = { code: string; hash: string };

// 32 letters and digits divide 256 evenly, so masking a random byte is unbiased.
function groups(count: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(count * 5));
  const chars = [...bytes].map((b) => ALPHABET[b & 31]!).join("");
  return chars.match(/.{5}/g)!.join("-");
}

async function made(code: string): Promise<OneTimeCode> {
  return { code, hash: await hashCode(code) };
}

// n codes for signing in once each, as two groups of five.
export async function newCodes(n: number): Promise<OneTimeCode[]> {
  const seen = new Set<string>();
  while (seen.size < n) seen.add(groups(2));
  return Promise.all([...seen].map(made));
}

// The code that gets a person back in without their app: five groups of five.
export function newRecoveryCode(): Promise<OneTimeCode> {
  return made(groups(5));
}
