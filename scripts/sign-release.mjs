#!/usr/bin/env node
// Signs a release bundle.
//
//   node scripts/sign-release.mjs --key <private-key-path> <bundle-dir>
//
// Reads the private key from that path alone (no environment variable, no repo file), refuses a
// path inside this repo, holds the bundle to its manifest, and writes manifest.sig beside
// manifest.json: base64url Ed25519 over the exact bytes of manifest.json. Prints no key. Leaves
// latest.json alone. Needs Node 24 (it imports the manifest module as TypeScript).
import { createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { CLIENT_DIR, MIGRATIONS_DIR, checkManifest } from "../src/shared/setup/releaseManifest.ts";
import { insideRepo } from "./make-release-key.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const bytesOf = (file) => new Uint8Array(readFileSync(file));

function filesUnder(dir) {
  const out = [];
  const visit = (at) => {
    for (const entry of readdirSync(at).sort()) {
      const full = join(at, entry);
      if (statSync(full).isDirectory()) visit(full);
      else out.push(full);
    }
  };
  visit(dir);
  return out;
}

/** Signs the bundle in `bundleDir` with the key at `keyPath`. Returns the signature file's path. */
export async function signRelease(keyPath, bundleDir, root = join(HERE, "..")) {
  if (!keyPath) throw new Error("Give the key with --key <path>.");
  if (!bundleDir) throw new Error("Give the bundle folder.");
  if (insideRepo(keyPath, root)) throw new Error("The private key must be kept outside this repo.");

  let manifestBytes;
  try {
    manifestBytes = bytesOf(join(bundleDir, "manifest.json"));
  } catch {
    throw new Error("The bundle folder has no manifest.json.");
  }
  let manifest;
  try {
    manifest = JSON.parse(new TextDecoder().decode(manifestBytes));
  } catch {
    throw new Error("The bundle's manifest.json is not valid JSON.");
  }
  const under = (sub, file) => relative(join(bundleDir, sub), file).split(sep).join("/");
  let problems;
  try {
    problems = await checkManifest(manifest, {
      worker: { path: manifest.worker.path, bytes: bytesOf(join(bundleDir, manifest.worker.path)) },
      client: filesUnder(join(bundleDir, CLIENT_DIR)).map((file) => ({ path: `/${under(CLIENT_DIR, file)}`, bytes: bytesOf(file) })),
      migrations: filesUnder(join(bundleDir, MIGRATIONS_DIR)).map((file) => ({ path: under(MIGRATIONS_DIR, file), bytes: bytesOf(file) })),
    });
  } catch {
    throw new Error("The bundle disagrees with its manifest: a file the manifest names is missing or the manifest is malformed.");
  }
  if (problems.length > 0) throw new Error(`The bundle disagrees with its manifest: ${problems[0]}`);

  let key;
  try {
    key = createPrivateKey(readFileSync(keyPath));
  } catch {
    throw new Error("The key file could not be read as a private key.");
  }
  if (key.asymmetricKeyType !== "ed25519") throw new Error("The key is not an Ed25519 key.");
  const signature = sign(null, manifestBytes, key);
  // Hold the signature to the public half of the same key before it is written: a bad write or a
  // wrong key type never leaves a signature file behind.
  if (!verify(null, manifestBytes, createPublicKey(key), signature)) throw new Error("The signature did not verify, so nothing was written.");
  const target = join(bundleDir, "manifest.sig");
  writeFileSync(target, `${signature.toString("base64url")}\n`);
  return target;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const args = process.argv.slice(2);
  const at = args.indexOf("--key");
  const keyPath = at >= 0 ? args[at + 1] : undefined;
  const bundleDir = args.filter((_, i) => i !== at && i !== at + 1)[0];
  signRelease(keyPath, bundleDir).then(
    (target) => console.log(`signed: ${target}`),
    (error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    },
  );
}
