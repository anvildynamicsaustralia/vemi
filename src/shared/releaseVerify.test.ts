import { describe, expect, it } from "vitest";
import { ISSUED_SKEW_MS, isNewer, issuedAtProblem, safeBundlePath, verifyManifest } from "./releaseVerify.js";

function b64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

async function newKey(): Promise<{ publicKey: string; sign: (bytes: Uint8Array) => Promise<string> }> {
  const pair = (await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"])) as CryptoKeyPair;
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  return {
    publicKey: b64url(raw),
    sign: async (bytes) => b64url(new Uint8Array(await crypto.subtle.sign("Ed25519", pair.privateKey, bytes as BufferSource))),
  };
}

const manifestBytes = new TextEncoder().encode(`${JSON.stringify({ format: 1, version: "1.2.3", issuedAt: "2026-11-25T00:00:00.000Z", notes: "x" }, null, 2)}\n`);

describe("issue date", () => {
  const now = new Date("2026-12-01T00:00:00.000Z");
  it("refuses a signed manifest without a readable issue date", async () => {
    const key = await newKey();
    for (const issuedAt of [undefined, "", "yesterday", "2026-11-25", 5, "2026-11-25T00:00:00Z"]) {
      const bytes = new TextEncoder().encode(JSON.stringify({ format: 1, version: "1.2.3", issuedAt, notes: "x" }));
      expect((await verifyManifest(bytes, await key.sign(bytes), key.publicKey)).ok, String(issuedAt)).toBe(false);
    }
  });
  it("takes a first date, the same date and a later one", () => {
    expect(issuedAtProblem("2026-11-30T00:00:00.000Z", now, null)).toBeNull();
    expect(issuedAtProblem("2026-11-30T00:00:00.000Z", now, "2026-11-30T00:00:00.000Z")).toBeNull();
    expect(issuedAtProblem("2026-11-30T12:00:00.000Z", now, "2026-11-30T00:00:00.000Z")).toBeNull();
  });
  it("refuses a date older than the one already accepted", () => {
    expect(issuedAtProblem("2026-11-29T23:59:59.999Z", now, "2026-11-30T00:00:00.000Z")).toBe("the release is older than one already accepted");
  });
  it("refuses a date more than the skew ahead, and takes one exactly at it", () => {
    expect(ISSUED_SKEW_MS).toBe(24 * 3_600_000);
    expect(issuedAtProblem("2026-12-02T00:00:00.001Z", now, null)).toBe("the release is dated in the future");
    expect(issuedAtProblem("2026-12-02T00:00:00.000Z", now, null)).toBeNull();
  });
});

describe("verifyManifest", () => {
  it("accepts a good release and returns the manifest", async () => {
    const key = await newKey();
    const result = await verifyManifest(manifestBytes, await key.sign(manifestBytes), key.publicKey);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.manifest.version).toBe("1.2.3");
  });

  it("refuses one changed manifest byte", async () => {
    const key = await newKey();
    const signature = await key.sign(manifestBytes);
    const changed = manifestBytes.slice();
    changed[changed.length - 3] = changed[changed.length - 3]! ^ 1;
    expect((await verifyManifest(changed, signature, key.publicKey)).ok).toBe(false);
  });

  it("refuses a signature from another key", async () => {
    const mine = await newKey();
    const other = await newKey();
    expect((await verifyManifest(manifestBytes, await other.sign(manifestBytes), mine.publicKey)).ok).toBe(false);
  });

  it("answers a sentence when the public key is empty", async () => {
    const key = await newKey();
    const result = await verifyManifest(manifestBytes, await key.sign(manifestBytes), "");
    expect(result).toEqual({ ok: false, error: "This copy has no release key, so no update can be checked." });
  });

  it("refuses malformed keys and signatures without throwing", async () => {
    const key = await newKey();
    const signature = await key.sign(manifestBytes);
    expect((await verifyManifest(manifestBytes, "not a signature!", key.publicKey)).ok).toBe(false);
    expect((await verifyManifest(manifestBytes, signature, "short")).ok).toBe(false);
    expect((await verifyManifest(manifestBytes, "", key.publicKey)).ok).toBe(false);
  });
});

describe("isNewer", () => {
  it("is true only for a higher version", () => {
    expect(isNewer("0.1.1", "0.1.0")).toBe(true);
    expect(isNewer("0.2.0", "0.1.9")).toBe(true);
    expect(isNewer("1.0.0", "0.9.9")).toBe(true);
    expect(isNewer("0.10.0", "0.9.0")).toBe(true);
  });
  it("refuses equal and older versions", () => {
    expect(isNewer("0.1.0", "0.1.0")).toBe(false);
    expect(isNewer("0.1.0", "0.1.1")).toBe(false);
    expect(isNewer("0.9.0", "0.10.0")).toBe(false);
  });
  it("refuses a version it cannot read", () => {
    expect(isNewer("latest", "0.1.0")).toBe(false);
    expect(isNewer("1.0", "0.1.0")).toBe(false);
    expect(isNewer("1.0.0-beta", "0.1.0")).toBe(false);
  });
});

describe("safeBundlePath", () => {
  it("accepts relative paths of plain characters", () => {
    expect(safeBundlePath("worker/index.js")).toBe(true);
    expect(safeBundlePath("client/assets/app-1.2_x.css")).toBe(true);
    expect(safeBundlePath("migrations/0033_self_update.sql")).toBe(true);
  });
  it("refuses a hostile path", () => {
    for (const path of ["", "/etc/passwd", "../x", "a/../b", "a//b", "./a", "a/.", "a b", "a\\b", "a?b", "a%2e%2e/b", "https://x/y", "é.js"]) {
      expect(safeBundlePath(path), path).toBe(false);
    }
  });
});
