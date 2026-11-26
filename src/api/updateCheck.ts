/**
 * The daily check for a newer release. One job on the one cron the Worker has: it runs every hour
 * and does nothing unless the last check was 23 hours ago or more, and nothing at all while the
 * copy has no release feed.
 *
 * It asks the feed with plain GETs (no cookie, no query, no header that says who is asking),
 * holds the manifest to the hash in `latest.json`, verifies its signature against the key built
 * into the copy, refuses a signed issue date older than the newest already accepted or more than a
 * day ahead of the clock, and keeps an offer only when the signed version is newer than the running one.
 * A bad signature, a network error, a body over 256 KB or any answer but 200 keeps the offer
 * already kept, writes one line to the log without the body, and never throws.
 */
import { isNewer, issuedAtProblem, verifyManifest } from "@vemi/shared";
import { openStore } from "./store.js";
import type { Job } from "./tick.js";

const DAY_MINUTES = 23 * 60;
const MAX_BYTES = 256 * 1024;
/** A feed that has not answered by now is treated as down; the next hour asks again. */
const FEED_TIMEOUT_MS = 20_000;
const VERSION_SHAPE = /^\d+\.\d+\.\d+$/;

export interface UpdateCheckConfig {
  /** The absolute base of the release files, ending in a slash. Empty means no check. */
  readonly feed: string;
  /** The Ed25519 public key releases are signed with, base64url. */
  readonly publicKey: string;
  /** The version the code running now is. */
  readonly version: string;
  readonly fetch: (url: string, init: RequestInit) => Promise<Response>;
}

class Refused extends Error {}

/** The body as bytes, refusing any answer but 200 and any body over the cap. */
async function getBytes(config: UpdateCheckConfig, url: string): Promise<Uint8Array> {
  const res = await config.fetch(url, { method: "GET", redirect: "follow", credentials: "omit", signal: AbortSignal.timeout(FEED_TIMEOUT_MS) } as RequestInit);
  if (res.status !== 200) throw new Refused(`answered ${res.status}`);
  const declared = Number(res.headers.get("content-length") ?? "0");
  if (declared > MAX_BYTES) throw new Refused("body too large");
  if (res.body === null) return new Uint8Array();
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > MAX_BYTES) {
      await reader.cancel();
      throw new Refused("body too large");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.length;
  }
  return bytes;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as BufferSource));
  return Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Reads the feed. Answers the signed release, or throws `Refused`. */
async function fetchRelease(
  config: UpdateCheckConfig, now: Date, accepted: string | null,
): Promise<{ version: string; manifest: string; signature: string; issuedAt: string }> {
  const latest = JSON.parse(new TextDecoder().decode(await getBytes(config, `${config.feed}latest.json`))) as unknown;
  if (latest === null || typeof latest !== "object") throw new Refused("latest.json is not an object");
  const { version, manifestSha256 } = latest as { version?: unknown; manifestSha256?: unknown };
  if (typeof version !== "string" || !VERSION_SHAPE.test(version) || typeof manifestSha256 !== "string") {
    throw new Refused("latest.json is not readable");
  }
  const bytes = await getBytes(config, `${config.feed}${version}/manifest.json`);
  const signature = new TextDecoder().decode(await getBytes(config, `${config.feed}${version}/manifest.sig`)).trim();
  if ((await sha256Hex(bytes)) !== manifestSha256) throw new Refused("manifest does not match latest.json");
  const verified = await verifyManifest(bytes, signature, config.publicKey);
  if (!verified.ok) throw new Refused("signature refused");
  if (verified.manifest.version !== version) throw new Refused("manifest version differs from latest.json");
  // A signed date older than one already accepted is an old feed played back; one far ahead is a bad date.
  const dated = issuedAtProblem(verified.manifest.issuedAt, now, accepted);
  if (dated !== null) throw new Refused(dated);
  return { version, manifest: new TextDecoder().decode(bytes), signature, issuedAt: verified.manifest.issuedAt };
}

export function createUpdateCheckJob(config: UpdateCheckConfig): Job {
  return {
    name: "update-check",
    // Every hour at minute 11; the job itself holds to once in 23 hours.
    schedule: "11 * * * *",
    async run(now, env) {
      if (config.feed === "") return;
      if (config.publicKey === "") {
        // A copy that cannot check a signature asks for nothing, and says why.
        console.error("update check skipped: this copy has no release key");
        return;
      }
      try {
        const store = openStore(env, () => now);
        const last = await store.updateCheck();
        if (last !== null && now.getTime() - new Date(last.checkedAt).getTime() < DAY_MINUTES * 60_000) return;
        const found = await fetchRelease(config, now, last?.issuedAt ?? null);
        const { issuedAt, ...offer } = found;
        await store.keepUpdateCheck(isNewer(found.version, config.version) ? offer : null, issuedAt);
      } catch (error) {
        // The reason only, never a body or an address.
        console.error(`update check failed: ${error instanceof Refused ? error.message : "could not be read"}`);
      }
    },
  };
}
