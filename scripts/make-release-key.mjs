#!/usr/bin/env node
// Makes the Ed25519 pair releases are signed with.
//
//   node scripts/make-release-key.mjs <private-key-path>
//
// Writes the private key to the path given and prints only the public key as base64url, the form
// RELEASE_PUBLIC_KEY holds. It refuses a path inside this repo and a path that already exists, so a
// key is never committed and never overwritten. Local only: no network.
import { generateKeyPairSync } from "node:crypto";
import { existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * The real location of `path`: symlinks followed as far as the path exists, the rest (a file not
 * written yet) appended as written. A key cannot hide inside the repo behind a link.
 */
function realish(path) {
  const full = resolve(path);
  const missing = [];
  let at = full;
  for (;;) {
    try {
      return join(realpathSync(at), ...missing.reverse());
    } catch {
      const up = dirname(at);
      if (up === at) return full;
      missing.push(basename(at));
      at = up;
    }
  }
}

/** True when `path` is the repo root or anywhere under it, links followed. */
export function insideRepo(path, root = join(HERE, "..")) {
  const rel = relative(realish(root), realish(path));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** Makes the pair, writes the private half to `path`, returns the public half as base64url. */
export function makeReleaseKey(path, root = join(HERE, "..")) {
  if (!path) throw new Error("Give the path to write the private key to.");
  if (insideRepo(path, root)) throw new Error("The private key must be kept outside this repo.");
  if (existsSync(path)) throw new Error("That path already exists, so nothing was written.");
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  mkdirSync(dirname(resolve(path)), { recursive: true });
  writeFileSync(path, privateKey.export({ type: "pkcs8", format: "pem" }), { flag: "wx", mode: 0o600 });
  return publicKey.export({ format: "jwk" }).x;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    console.log(makeReleaseKey(process.argv[2]));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
