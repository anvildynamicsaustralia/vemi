/**
 * The release manifest: one list of every file a copy needs to run a version of VEMI, with a size
 * and a hash for each, built and checked here and nowhere else. Pure: it is given bytes and
 * answers with data. Reading and writing files is the script's job (scripts/build-release.mjs).
 *
 * The client hash rule is Cloudflare's for a direct asset upload: SHA-256 over the file's base64
 * text followed by its extension (no dot), hex-encoded. Cloudflare keys an asset by the first 32
 * characters. The manifest keeps all 64, so a reader cuts it with `assetKey`; the full length also
 * keeps the manifest clear of the release scan's 32-hex shape.
 */

/** One file with its bundle-relative path and content. */
export interface ReleaseFile {
  path: string;
  bytes: Uint8Array;
}

export interface ReleaseBinding {
  name: string;
  type: string;
}

/** What the script gathers from the build; everything the manifest is made from. */
export interface ReleaseInput {
  version: string;
  /** When this release was issued, ISO 8601 in UTC (`2026-11-25T03:04:05.000Z`). It goes into the signed manifest. */
  issuedAt: string;
  /** The whole `RELEASE_NOTES.md`; the section for `version` goes into the manifest. */
  notesFile: string;
  compatibilityDate: string;
  bindings: ReleaseBinding[];
  variables: string[];
  /** The Worker module, named as Cloudflare is told its `main_module`. */
  worker: ReleaseFile;
  /** Client files, `path` is the served path with a leading slash (`/assets/app.js`). */
  client: ReleaseFile[];
  /** Migrations, `path` is the file name (`0031_session_key.sql`). */
  migrations: ReleaseFile[];
}

export interface ManifestWorker {
  path: string;
  size: number;
  sha256: string;
}

export interface ManifestClientFile {
  path: string;
  size: number;
  /** 64 hex characters; `assetKey` gives Cloudflare's 32. */
  assetHash: string;
}

export interface ManifestMigration {
  name: string;
  sha256: string;
}

export interface ReleaseManifest {
  format: 1;
  version: string;
  /** When the release was issued, ISO 8601 in UTC. Signed with the rest, so a replayed old feed shows its age. */
  issuedAt: string;
  notes: string;
  compatibilityDate: string;
  bindings: ReleaseBinding[];
  variables: string[];
  worker: ManifestWorker;
  client: ManifestClientFile[];
  migrations: ManifestMigration[];
}

/** Where each part sits inside `dist/release/<version>/`. */
export const WORKER_DIR = "worker";
export const CLIENT_DIR = "client";
export const MIGRATIONS_DIR = "migrations";

const HEX = "0123456789abcdef";

function toHex(buffer: ArrayBuffer): string {
  let out = "";
  for (const byte of new Uint8Array(buffer)) out += HEX[byte >> 4]! + HEX[byte & 15]!;
  return out;
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  return toHex(await crypto.subtle.digest("SHA-256", bytes as BufferSource));
}

function base64(bytes: Uint8Array): string {
  let binary = "";
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) binary += String.fromCharCode(...bytes.subarray(i, i + step));
  return btoa(binary);
}

/** A file's extension without the dot; none for a name with no dot after its last slash. */
function extensionOf(path: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? "" : name.slice(dot + 1);
}

/** The client hash rule: full 64 hex characters. */
export async function assetHash(file: ReleaseFile): Promise<string> {
  const text = base64(file.bytes) + extensionOf(file.path);
  return sha256Hex(new TextEncoder().encode(text));
}

/** Cloudflare's key for an asset: the first 32 characters of the hash. */
export function assetKey(hash: string): string {
  return hash.slice(0, 32);
}

/** True for the exact shape `new Date().toISOString()` writes, and a real moment. */
export function isIssuedAt(text: unknown): text is string {
  return typeof text === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(text) && !Number.isNaN(Date.parse(text)) && new Date(text).toISOString() === text;
}

const MIGRATION_NAME = /^(\d{4})_[A-Za-z0-9_]+\.sql$/;

/** The problems with a list of migration names: a bad name, a repeat, or a number that does not rise. */
export function migrationOrderProblems(names: readonly string[]): string[] {
  const problems: string[] = [];
  let last = -1;
  for (const name of names) {
    const match = MIGRATION_NAME.exec(name);
    if (!match) {
      problems.push(`migration ${name} is not named NNNN_name.sql`);
      continue;
    }
    const number = Number(match[1]);
    if (number === last) problems.push(`migration number ${match[1]} is used twice`);
    else if (number < last) problems.push(`migration ${name} is out of order`);
    last = Math.max(last, number);
  }
  return problems;
}

/** The text under the `## <version>` heading of the release notes, or null when there is none. */
export function notesFor(notesFile: string, version: string): string | null {
  const lines = notesFile.replace(/\r\n/g, "\n").split("\n");
  const start = lines.findIndex((line) => line === `## ${version}` || line.startsWith(`## ${version} `));
  if (start < 0) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i]!.startsWith("## ")) {
      end = i;
      break;
    }
  }
  const text = lines.slice(start + 1, end).join("\n").trim();
  return text === "" ? null : text;
}

function byPath<T extends { path: string }>(a: T, b: T): number {
  return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
}

/** Builds the manifest. Throws a sentence when the input cannot make a true one. */
export async function buildManifest(input: ReleaseInput): Promise<ReleaseManifest> {
  const notes = notesFor(input.notesFile, input.version);
  if (notes === null) throw new Error(`RELEASE_NOTES.md has no section for ${input.version}`);
  if (!isIssuedAt(input.issuedAt)) throw new Error("issuedAt is not an ISO 8601 UTC time like 2026-11-25T03:04:05.000Z");
  const order = migrationOrderProblems(input.migrations.map((file) => file.path));
  if (order.length > 0) throw new Error(order.join("; "));

  const client: ManifestClientFile[] = [];
  for (const file of [...input.client].sort(byPath)) {
    client.push({ path: file.path, size: file.bytes.length, assetHash: await assetHash(file) });
  }
  const migrations: ManifestMigration[] = [];
  for (const file of input.migrations) migrations.push({ name: file.path, sha256: await sha256Hex(file.bytes) });

  return {
    format: 1,
    version: input.version,
    issuedAt: input.issuedAt,
    notes,
    compatibilityDate: input.compatibilityDate,
    bindings: input.bindings,
    variables: input.variables,
    worker: { path: input.worker.path, size: input.worker.bytes.length, sha256: await sha256Hex(input.worker.bytes) },
    client,
    migrations,
  };
}

/** The files a bundle holds, as the manifest sees them: worker, client and migration bytes by name. */
export interface BundleFiles {
  worker: ReleaseFile;
  client: ReleaseFile[];
  migrations: ReleaseFile[];
}

/**
 * Every way the files and the manifest disagree, as sentences; empty when they agree. A file added,
 * removed or changed after the manifest was written, or a migration out of order, shows here.
 */
export async function checkManifest(manifest: ReleaseManifest, files: BundleFiles): Promise<string[]> {
  const problems: string[] = [];

  if (files.worker.path !== manifest.worker.path) problems.push(`the Worker is ${files.worker.path}, the manifest says ${manifest.worker.path}`);
  else if (files.worker.bytes.length !== manifest.worker.size) problems.push(`the Worker is ${files.worker.bytes.length} bytes, the manifest says ${manifest.worker.size}`);
  else if ((await sha256Hex(files.worker.bytes)) !== manifest.worker.sha256) problems.push("the Worker has changed since the manifest was written");

  const clientNow = new Map(files.client.map((file) => [file.path, file]));
  const clientListed = new Set<string>();
  for (const line of manifest.client) {
    clientListed.add(line.path);
    const file = clientNow.get(line.path);
    if (!file) problems.push(`client file ${line.path} is listed but missing`);
    else if (file.bytes.length !== line.size) problems.push(`client file ${line.path} is ${file.bytes.length} bytes, the manifest says ${line.size}`);
    else if ((await assetHash(file)) !== line.assetHash) problems.push(`client file ${line.path} has changed since the manifest was written`);
  }
  for (const path of clientNow.keys()) if (!clientListed.has(path)) problems.push(`client file ${path} is not in the manifest`);

  problems.push(...migrationOrderProblems(manifest.migrations.map((line) => line.name)));
  const migrationsNow = new Map(files.migrations.map((file) => [file.path, file]));
  const migrationsListed = new Set<string>();
  for (const line of manifest.migrations) {
    migrationsListed.add(line.name);
    const file = migrationsNow.get(line.name);
    if (!file) problems.push(`migration ${line.name} is listed but missing`);
    else if ((await sha256Hex(file.bytes)) !== line.sha256) problems.push(`migration ${line.name} has changed since the manifest was written`);
  }
  for (const name of migrationsNow.keys()) if (!migrationsListed.has(name)) problems.push(`migration ${name} is not in the manifest`);

  return problems;
}

/** The manifest as written to disk: stable key order, two-space indent, a closing newline. */
export function manifestText(manifest: ReleaseManifest): string {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

/** The `latest.json` text: the version and the hash of the manifest's own text. */
export async function latestText(version: string, manifestFileText: string): Promise<string> {
  const manifestSha256 = await sha256Hex(new TextEncoder().encode(manifestFileText));
  return `${JSON.stringify({ version, manifestSha256 }, null, 2)}\n`;
}
