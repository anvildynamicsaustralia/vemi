import { type Bytes, fromBase64Url, fromUtf8, randomBytes, toBase64Url, utf8 } from "./bytes.js";

/**
 * Why a key operation failed.
 *  version: an envelope written by a format this code does not know.
 *  key: the envelope or wrapping belongs to a different key.
 *  binding: it does not open for this key under this record, field, kind or pairing.
 *  damaged: the text is not a well-formed envelope or wrapped copy.
 */
export type CryptoFailure = "version" | "key" | "binding" | "damaged";

export class CryptoError extends Error {
  readonly reason: CryptoFailure;
  constructor(reason: CryptoFailure) {
    super(`Key operation refused (${reason}).`);
    this.name = "CryptoError";
    this.reason = reason;
  }
}

/** Which record and field a sealed value belongs to. `keyRef`, when given, is checked first. */
export interface Binding {
  record: string;
  field: string;
  keyRef?: string;
}

const VERSION = "v1";
const IV_BYTES = 12;
const TAG_BYTES = 16;

function aad(keyRef: string, record: string, field: string): Bytes {
  return utf8(`vemi:${VERSION}:${keyRef}:${record}:${field}`);
}

interface Parts {
  keyRef: string;
  iv: Bytes;
  data: Bytes;
}

function parse(envelope: string): Parts {
  const parts = envelope.split(".");
  const version = parts[0] ?? "";
  if (version !== VERSION) {
    // Any other well-formed version label is another format, not damage.
    throw new CryptoError(/^v\d{1,3}$/.test(version) ? "version" : "damaged");
  }
  if (parts.length !== 4) throw new CryptoError("damaged");
  const keyRef = parts[1] ?? "";
  const ref = fromBase64Url(keyRef);
  const iv = fromBase64Url(parts[2] ?? "");
  const data = fromBase64Url(parts[3] ?? "");
  if (!ref || ref.length !== 8 || !iv || iv.length !== IV_BYTES || !data || data.length < TAG_BYTES) {
    throw new CryptoError("damaged");
  }
  return { keyRef, iv, data };
}

/** The key ref an envelope names, so a device can tell which key sealed it. */
export function envelopeKeyRef(envelope: string): string {
  return parse(envelope).keyRef;
}

export async function seal(
  fieldKey: CryptoKey,
  keyRef: string,
  plaintext: string,
  binding: Pick<Binding, "record" | "field">,
): Promise<string> {
  const iv = randomBytes(IV_BYTES);
  const data = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: aad(keyRef, binding.record, binding.field) },
    fieldKey,
    utf8(plaintext),
  );
  return [VERSION, keyRef, toBase64Url(iv), toBase64Url(new Uint8Array(data))].join(".");
}

export async function open(fieldKey: CryptoKey, envelope: string, binding: Binding): Promise<string> {
  const { keyRef, iv, data } = parse(envelope);
  if (binding.keyRef !== undefined && binding.keyRef !== keyRef) throw new CryptoError("key");
  try {
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv, additionalData: aad(keyRef, binding.record, binding.field) },
      fieldKey,
      data,
    );
    return fromUtf8(new Uint8Array(plain));
  } catch {
    // AES-GCM cannot say whether the key, the binding or a byte was wrong.
    throw new CryptoError("binding");
  }
}

/** Moves an envelope to another record or field; the key ref stays the one it was sealed under. */
export async function reseal(
  fieldKey: CryptoKey,
  envelope: string,
  from: Pick<Binding, "record" | "field">,
  to: Pick<Binding, "record" | "field">,
): Promise<string> {
  const plain = await open(fieldKey, envelope, from);
  return seal(fieldKey, envelopeKeyRef(envelope), plain, to);
}
