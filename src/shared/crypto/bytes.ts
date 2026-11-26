/**
 * Small byte helpers under the key and envelope module. WebCrypto only: nothing here
 * needs a package, and the same code runs in the browser, workerd and Node.
 */

export type Bytes = Uint8Array<ArrayBuffer>;

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });

export function utf8(text: string): Bytes {
  return new Uint8Array(encoder.encode(text));
}

export function fromUtf8(bytes: Uint8Array): string {
  return decoder.decode(bytes);
}

export function randomBytes(length: number): Bytes {
  const out = new Uint8Array(length);
  crypto.getRandomValues(out);
  return out;
}

/** Same length and same bytes, without stopping at the first difference. */
export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

const URL_SAFE = /^[A-Za-z0-9_-]*$/;

export function toBase64Url(bytes: Uint8Array): string {
  let text = "";
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Null when the text is not base64url, so callers choose their own error. */
export function fromBase64Url(text: string): Bytes | null {
  if (!URL_SAFE.test(text) || text.length % 4 === 1) return null;
  const padded = text.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((text.length + 3) % 4);
  try {
    const raw = atob(padded);
    const out = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

/** HKDF-SHA256 with an empty salt; the label is the whole separation between uses. */
export async function hkdf(secret: Uint8Array, label: string, length: number): Promise<Bytes> {
  const base = await crypto.subtle.importKey("raw", secret as Bytes, "HKDF", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: utf8(label) },
    base,
    length * 8,
  );
  return new Uint8Array(bits);
}

/** A 256-bit AES-GCM key that cannot be exported once made. */
export function aesKeyFrom(raw: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", raw as Bytes, "AES-GCM", false, ["encrypt", "decrypt"]);
}
