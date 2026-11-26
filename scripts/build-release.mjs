#!/usr/bin/env node
// Writes the release bundle: everything a copy needs to run one version of VEMI.
//
//   pnpm run release        build, then this
//   node scripts/build-release.mjs
//
// Reads dist/worker (the Worker module) and dist/web (the client) from the build, migrations/ and
// RELEASE_NOTES.md, and writes dist/release/<version>/ and dist/release/latest.json. Local only:
// it touches no network and nothing on Cloudflare. The manifest has no signature yet; the
// self-update work adds it. Needs Node 24 (it imports the manifest module as TypeScript).
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { stripJsonc } from "./andy-config.mjs";
import {
  CLIENT_DIR,
  MIGRATIONS_DIR,
  WORKER_DIR,
  buildManifest,
  checkManifest,
  latestText,
  manifestText,
} from "../src/shared/setup/releaseManifest.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const WORKER_FILE = "index.js";

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

const bytesOf = (file) => new Uint8Array(readFileSync(file));

/** What the Worker expects from the copy that runs it, read from the Worker config. */
function expectations(config) {
  const bindings = [];
  for (const db of config.d1_databases ?? []) bindings.push({ name: db.binding, type: "d1" });
  for (const object of config.durable_objects?.bindings ?? []) bindings.push({ name: object.name, type: "durable_object_namespace" });
  if (config.assets) bindings.push({ name: config.assets.binding ?? "ASSETS", type: "assets" });
  return { bindings, variables: Object.keys(config.vars ?? {}) };
}

/**
 * Builds the bundle for the project at `root`. Returns where it went and the manifest. Throws a
 * sentence when the build output is missing, the notes lack the version, or the written bundle
 * does not agree with its own manifest.
 */
export async function buildRelease(root = join(HERE, ".."), now = new Date()) {
  const read = (...parts) => join(root, ...parts);
  for (const dir of [read("dist", "worker"), read("dist", "web")]) {
    if (!statSync(dir, { throwIfNoEntry: false })?.isDirectory()) {
      throw new Error(`${relative(root, dir).split(sep).join("/")} is missing; run the build first`);
    }
  }
  const version = JSON.parse(readFileSync(read("package.json"), "utf8")).version;
  // The version names a folder that is emptied and rewritten, so it has to be a plain semver.
  if (typeof version !== "string" || !/^\d+\.\d+\.\d+(-[0-9A-Za-z][0-9A-Za-z.-]*)?$/.test(version)) {
    throw new Error("package.json version is not a plain version number like 1.2.3");
  }
  const config = JSON.parse(stripJsonc(readFileSync(read("wrangler.jsonc"), "utf8")));

  const worker = { path: `${WORKER_DIR}/${WORKER_FILE}`, bytes: bytesOf(read("dist", "worker", WORKER_FILE)) };
  const client = filesUnder(read("dist", "web")).map((file) => ({
    path: `/${relative(read("dist", "web"), file).split(sep).join("/")}`,
    bytes: bytesOf(file),
  }));
  const migrations = readdirSync(read("migrations"))
    .filter((name) => name.endsWith(".sql"))
    .sort()
    .map((name) => ({ path: name, bytes: bytesOf(read("migrations", name)) }));

  const manifest = await buildManifest({
    version,
    issuedAt: now.toISOString(),
    notesFile: readFileSync(read("RELEASE_NOTES.md"), "utf8"),
    compatibilityDate: config.compatibility_date,
    ...expectations(config),
    worker,
    client,
    migrations,
  });

  const releaseDir = read("dist", "release");
  const out = join(releaseDir, version);
  rmSync(out, { recursive: true, force: true });
  const put = (relativePath, bytes) => {
    const target = join(out, relativePath);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, bytes);
  };
  put(worker.path, worker.bytes);
  for (const file of client) put(`${CLIENT_DIR}${file.path}`, file.bytes);
  for (const file of migrations) put(`${MIGRATIONS_DIR}/${file.path}`, file.bytes);

  const text = manifestText(manifest);
  put("manifest.json", text);
  writeFileSync(join(releaseDir, "latest.json"), await latestText(version, text));

  // Read the bundle back from disk and hold it to its own manifest.
  const written = {
    worker: { path: worker.path, bytes: bytesOf(join(out, worker.path)) },
    client: client.map((file) => ({ path: file.path, bytes: bytesOf(join(out, CLIENT_DIR, file.path)) })),
    migrations: migrations.map((file) => ({ path: file.path, bytes: bytesOf(join(out, MIGRATIONS_DIR, file.path)) })),
  };
  const problems = await checkManifest(manifest, written);
  if (problems.length > 0) throw new Error(`the bundle disagrees with its manifest: ${problems[0]}`);

  return { dir: out, manifest };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  buildRelease().then(
    ({ dir, manifest }) => {
      console.log(`release ${manifest.version}: ${manifest.client.length} client files, ${manifest.migrations.length} migrations -> ${relative(process.cwd(), dir)}`);
    },
    (error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    },
  );
}
