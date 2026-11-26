/**
 * Decides whether release bytes are to be trusted. Pure: no network, no storage.
 *
 * A manifest is trusted only when an Ed25519 signature over its exact bytes verifies against the
 * public key built into the copy. It refuses an empty key, a malformed key or signature, and any
 * path that could leave the bundle folder.
 */
import { isIssuedAt, type ReleaseManifest } from "./setup/releaseManifest.js";

export type Verified = { ok: true; manifest: ReleaseManifest } | { ok: false; error: string };

const REFUSED = "This update could not be checked, so it was not installed.";

function fromBase64Url(text: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+$/.test(text)) return null;
  try {
    const binary = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
    return Uint8Array.from(binary, (char) => char.charCodeAt(0));
  } catch {
    return null;
  }
}

/**
 * Checks `signature` (base64url Ed25519) over the exact `bytes` of manifest.json against
 * `publicKey` (32 raw bytes as base64url), then reads the manifest. Never throws.
 */
export async function verifyManifest(bytes: Uint8Array, signature: string, publicKey: string): Promise<Verified> {
  if (publicKey === "") return { ok: false, error: "This copy has no release key, so no update can be checked." };
  const key = fromBase64Url(publicKey);
  const sig = fromBase64Url(signature.trim());
  if (key === null || key.length !== 32 || sig === null || sig.length !== 64) return { ok: false, error: REFUSED };
  try {
    const imported = await crypto.subtle.importKey("raw", key as BufferSource, "Ed25519", false, ["verify"]);
    if (!(await crypto.subtle.verify("Ed25519", imported, sig as BufferSource, bytes as BufferSource))) {
      return { ok: false, error: REFUSED };
    }
    const manifest = JSON.parse(new TextDecoder().decode(bytes)) as ReleaseManifest;
    if (manifest === null || typeof manifest !== "object" || typeof manifest.version !== "string") return { ok: false, error: REFUSED };
    // The signed issue date is required: a manifest without one is an old format and is not trusted.
    if (!isIssuedAt(manifest.issuedAt)) return { ok: false, error: REFUSED };
    return { ok: true, manifest };
  } catch {
    return { ok: false, error: REFUSED };
  }
}

function parts(version: string): number[] | null {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  return match === null ? null : [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** True only when `candidate` is strictly newer than `current`. Equal, older or unreadable is false. */
export function isNewer(candidate: string, current: string): boolean {
  const a = parts(candidate);
  const b = parts(current);
  if (a === null || b === null) return false;
  for (let i = 0; i < 3; i += 1) {
    if (a[i]! !== b[i]!) return a[i]! > b[i]!;
  }
  return false;
}

/**
 * How far ahead of this copy's clock a signed issue date may be. A day is wide enough for a
 * copy whose clock is off and for a release signed in another time zone, and narrow enough that
 * a date typed wrong years ahead cannot lock out every later release.
 */
export const ISSUED_SKEW_MS = 24 * 60 * 60 * 1000;

/**
 * Holds a signed `issuedAt` to two rules, given the newest date this copy has already accepted
 * (or null). Refused: a date older than the accepted one, which is an old feed played back, and a
 * date more than `ISSUED_SKEW_MS` after `now`. The same date as the accepted one is fine: the
 * daily check reads the same release again. Answers null when fine, else the reason.
 */
export function issuedAtProblem(issuedAt: string, now: Date, accepted: string | null): string | null {
  const at = Date.parse(issuedAt);
  if (Number.isNaN(at)) return "the release has no readable issue date";
  if (at > now.getTime() + ISSUED_SKEW_MS) return "the release is dated in the future";
  if (accepted !== null && at < Date.parse(accepted)) return "the release is older than one already accepted";
  return null;
}

/** True for a relative path of letters, digits, dot, underscore, dash and slash with no `..` part. */
export function safeBundlePath(path: string): boolean {
  if (path === "" || path.startsWith("/") || !/^[A-Za-z0-9._/-]+$/.test(path)) return false;
  return path.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}
