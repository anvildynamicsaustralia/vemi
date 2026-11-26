import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildManifest, manifestText } from "../src/shared/setup/releaseManifest.js";
import { verifyManifest } from "../src/shared/releaseVerify.js";
// @ts-expect-error the script is plain JavaScript
import { insideRepo, makeReleaseKey } from "./make-release-key.mjs";
// @ts-expect-error the script is plain JavaScript
import { signRelease } from "./sign-release.mjs";

const REPO = resolve(import.meta.dirname, "..");
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function temp(): string {
  const root = mkdtempSync(join(tmpdir(), "vemi-sign-"));
  roots.push(root);
  return root;
}

const bytes = (text: string) => new TextEncoder().encode(text);

/** A small finished bundle on disk, agreeing with its manifest. */
async function bundle(): Promise<string> {
  const dir = join(temp(), "1.2.3");
  const worker = { path: "worker/index.js", bytes: bytes("export default {};") };
  const client = [{ path: "/index.html", bytes: bytes("<html></html>") }];
  const migrations = [{ path: "0001_a.sql", bytes: bytes("CREATE TABLE a (id INTEGER);\n") }];
  const manifest = await buildManifest({
    version: "1.2.3",
    issuedAt: "2026-11-25T00:00:00.000Z",
    notesFile: "## 1.2.3\n\nChanged.\n",
    compatibilityDate: "2026-09-11",
    bindings: [],
    variables: [],
    worker,
    client,
    migrations,
  });
  mkdirSync(join(dir, "worker"), { recursive: true });
  mkdirSync(join(dir, "client"), { recursive: true });
  mkdirSync(join(dir, "migrations"), { recursive: true });
  writeFileSync(join(dir, worker.path), worker.bytes);
  writeFileSync(join(dir, "client/index.html"), client[0]!.bytes);
  writeFileSync(join(dir, "migrations/0001_a.sql"), migrations[0]!.bytes);
  writeFileSync(join(dir, "manifest.json"), manifestText(manifest));
  writeFileSync(join(dir, "latest.json"), '{"version":"1.2.3"}\n');
  return dir;
}

describe("make-release-key", () => {
  it("writes the private key to the path and returns only the public key", () => {
    const path = join(temp(), "keys", "release.pem");
    const publicKey: string = makeReleaseKey(path);
    expect(publicKey).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(readFileSync(path, "utf8")).toContain("PRIVATE KEY");
    expect(publicKey).not.toContain("PRIVATE");
  });

  it("refuses a path that exists and a path inside the repo", () => {
    const path = join(temp(), "release.pem");
    writeFileSync(path, "keep me");
    expect(() => makeReleaseKey(path)).toThrow("already exists");
    expect(readFileSync(path, "utf8")).toBe("keep me");
    const inside = join(REPO, "release-test.pem");
    expect(() => makeReleaseKey(inside)).toThrow("outside this repo");
    expect(existsSync(inside)).toBe(false);
  });
});

describe("sign-release", () => {
  it("signs a good bundle so the public key verifies the exact manifest bytes", async () => {
    const dir = await bundle();
    const keyPath = join(temp(), "release.pem");
    const publicKey: string = makeReleaseKey(keyPath);
    const latestBefore = readFileSync(join(dir, "latest.json"), "utf8");

    await signRelease(keyPath, dir);

    const manifest = new Uint8Array(readFileSync(join(dir, "manifest.json")));
    const signature = readFileSync(join(dir, "manifest.sig"), "utf8");
    const result = await verifyManifest(manifest, signature, publicKey);
    expect(result.ok).toBe(true);
    expect(readFileSync(join(dir, "latest.json"), "utf8")).toBe(latestBefore);

    manifest[10] = manifest[10]! ^ 1;
    expect((await verifyManifest(manifest, signature, publicKey)).ok).toBe(false);
  });

  it("refuses a bundle that disagrees with its manifest and writes no signature", async () => {
    const dir = await bundle();
    writeFileSync(join(dir, "worker/index.js"), "export default { changed: true };");
    const keyPath = join(temp(), "release.pem");
    makeReleaseKey(keyPath);
    await expect(signRelease(keyPath, dir)).rejects.toThrow("disagrees with its manifest");
    expect(existsSync(join(dir, "manifest.sig"))).toBe(false);
  });

  it("refuses a key path inside the repo, and prints nothing secret", async () => {
    const dir = await bundle();
    const inside = join(REPO, "package.json");
    const run = spawnSync(process.execPath, [join(REPO, "scripts/sign-release.mjs"), "--key", inside, dir], { encoding: "utf8" });
    expect(run.status).not.toBe(0);
    expect(run.stdout).toBe("");
    expect(run.stderr).toContain("outside this repo");
    expect(`${run.stdout}${run.stderr}`).not.toMatch(/PRIVATE KEY|BEGIN/);
    expect(existsSync(join(dir, "manifest.sig"))).toBe(false);
  });

  it("through the command line prints no key", async () => {
    const dir = await bundle();
    const keyPath = join(temp(), "release.pem");
    const publicKey: string = makeReleaseKey(keyPath);
    const secret = readFileSync(keyPath, "utf8");
    const run = spawnSync(process.execPath, [join(REPO, "scripts/sign-release.mjs"), "--key", keyPath, dir], { encoding: "utf8" });
    expect(run.status).toBe(0);
    const out = `${run.stdout}${run.stderr}`;
    expect(out).not.toContain(secret.split("\n")[1]!);
    expect(out).not.toContain("PRIVATE KEY");
    expect(out).not.toContain(publicKey);
    expect(statSync(join(dir, "manifest.sig")).size).toBeGreaterThan(80);
  });

  it("refuses a missing key, a missing bundle, a bad manifest, and a key that is not a private Ed25519 key", async () => {
    const dir = await bundle();
    const keyPath = join(temp(), "release.pem");
    makeReleaseKey(keyPath);
    await expect(signRelease(undefined, dir)).rejects.toThrow("--key");
    await expect(signRelease(keyPath, undefined)).rejects.toThrow("bundle folder");
    await expect(signRelease(keyPath, join(temp(), "nothing-here"))).rejects.toThrow("no manifest.json");

    const garbage = join(temp(), "garbage.pem");
    writeFileSync(garbage, "not a key at all");
    await expect(signRelease(garbage, dir)).rejects.toThrow("could not be read as a private key");
    await expect(signRelease(join(temp(), "absent.pem"), dir)).rejects.toThrow("could not be read as a private key");

    const rsa = join(temp(), "rsa.pem");
    writeFileSync(rsa, generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }));
    await expect(signRelease(rsa, dir)).rejects.toThrow("not an Ed25519 key");

    const bad = await bundle();
    writeFileSync(join(bad, "manifest.json"), "{ not json");
    await expect(signRelease(keyPath, bad)).rejects.toThrow("not valid JSON");
    expect(existsSync(join(bad, "manifest.sig"))).toBe(false);
    expect(existsSync(join(dir, "manifest.sig"))).toBe(false);
  });

  it("refuses a bundle with a file the manifest does not list, or one it lists that is gone", async () => {
    const keyPath = join(temp(), "release.pem");
    makeReleaseKey(keyPath);
    const extra = await bundle();
    writeFileSync(join(extra, "client", "sneaked-in.js"), "alert(1)");
    await expect(signRelease(keyPath, extra)).rejects.toThrow("disagrees with its manifest");
    const gone = await bundle();
    rmSync(join(gone, "client", "index.html"));
    await expect(signRelease(keyPath, gone)).rejects.toThrow("disagrees with its manifest");
    const noWorker = await bundle();
    rmSync(join(noWorker, "worker", "index.js"));
    await expect(signRelease(keyPath, noWorker)).rejects.toThrow("disagrees with its manifest");
    for (const dir of [extra, gone, noWorker]) expect(existsSync(join(dir, "manifest.sig"))).toBe(false);
  });

  it("signs a changed manifest afresh, replacing an older signature", async () => {
    const dir = await bundle();
    const keyPath = join(temp(), "release.pem");
    const publicKey: string = makeReleaseKey(keyPath);
    await signRelease(keyPath, dir);
    const first = readFileSync(join(dir, "manifest.sig"), "utf8");
    const other = join(temp(), "other.pem");
    const otherPublic: string = makeReleaseKey(other);
    await signRelease(other, dir);
    const second = readFileSync(join(dir, "manifest.sig"), "utf8");
    expect(second).not.toBe(first);
    const manifest = new Uint8Array(readFileSync(join(dir, "manifest.json")));
    expect((await verifyManifest(manifest, second, otherPublic)).ok).toBe(true);
    expect((await verifyManifest(manifest, second, publicKey)).ok).toBe(false);
  });
});

describe("a key kept outside the repo", () => {
  it("is refused when its path reaches the repo through a link, and when it is the repo root itself", (context) => {
    const outside = temp();
    const link = join(outside, "into-repo");
    try {
      symlinkSync(REPO, link, "junction");
    } catch {
      context.skip();
      return;
    }
    const through = join(link, "linked-release.pem");
    expect(insideRepo(through)).toBe(true);
    expect(() => makeReleaseKey(through)).toThrow("outside this repo");
    expect(existsSync(join(REPO, "linked-release.pem"))).toBe(false);
    expect(insideRepo(REPO)).toBe(true);
    expect(insideRepo(join(outside, "release.pem"))).toBe(false);
  });
});
