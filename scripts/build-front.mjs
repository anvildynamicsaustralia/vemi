#!/usr/bin/env node
// Assembles dist/front, the files the front door serves as plain static assets.
//
//   pnpm run build:front    build and release first, then this
//   node scripts/build-front.mjs
//
// Reads dist/web (only what /get/ needs) and dist/release/ (latest.json and one folder a version)
// and writes dist/front. Local only: it touches no network and nothing on Cloudflare.
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * Folders of dist/web the front serves: the /get/ page and the /try/ page (with the database
 * worker and wasm under try/assets), and the app's tokens, fonts, icons both load from.
 */
const WEB_FOLDERS = ["get", "try", "assets", "icons"];

/** Readable from any page, so a copy can fetch what is new without the front running a Worker. */
const RELEASE_HEADERS = ["/release/*", "  Access-Control-Allow-Origin: *", "  Cache-Control: no-cache"].join("\n");

const isDirectory = (path) => statSync(path, { throwIfNoEntry: false })?.isDirectory() === true;

/**
 * Builds dist/front for the project at `root`. Returns the folder. Throws a sentence when the
 * build or the release is missing.
 */
export function buildFront(root = join(HERE, "..")) {
  const web = join(root, "dist", "web");
  const release = join(root, "dist", "release");
  if (!isDirectory(web)) throw new Error("dist/web is missing; run the build first");
  if (!existsSync(join(web, "get", "index.html"))) throw new Error("dist/web/get/index.html is missing; the setup page is not built");
  if (!existsSync(join(web, "try", "index.html"))) throw new Error("dist/web/try/index.html is missing; the local page is not built");
  if (!isDirectory(release) || !existsSync(join(release, "latest.json"))) {
    throw new Error("dist/release/latest.json is missing; run pnpm run release first");
  }

  const out = join(root, "dist", "front");
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  for (const folder of WEB_FOLDERS) {
    if (isDirectory(join(web, folder))) cpSync(join(web, folder), join(out, folder), { recursive: true });
  }
  cpSync(release, join(out, "release"), { recursive: true });

  // The app's own headers (the /get/* policy among them) plus the release rule.
  const headers = existsSync(join(web, "_headers")) ? readFileSync(join(web, "_headers"), "utf8").trimEnd() + "\n\n" : "";
  writeFileSync(join(out, "_headers"), `${headers}${RELEASE_HEADERS}\n`);
  // The front has no landing page yet: / goes to /get/, answered by assets, not by the Worker.
  writeFileSync(join(out, "_redirects"), "/ /get/ 302\n");
  return out;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    console.log(`front assembled in ${buildFront()}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
