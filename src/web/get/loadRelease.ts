/**
 * Reads a release from the front's static files: `/release/latest.json` names the version and
 * the hash of its manifest, `/release/<version>/manifest.json` lists every file, and each file
 * sits under the version's folder. Everything read is held to the manifest before it is used.
 * No Cloudflare call, no app route: plain files from this page's own origin.
 */
import { SetupError } from "../../shared/setup/cloudflareApi.js";
import type { BuildBundle } from "../../shared/setup/buildSteps.js";
import {
  CLIENT_DIR, MIGRATIONS_DIR, checkManifest, sha256Hex,
  type ReleaseFile, type ReleaseManifest,
} from "../../shared/setup/releaseManifest.js";

export const RELEASE_ROOT = "/release";
const NO_RELEASE = "The VEMI files could not be fetched. Check your connection, or use the Deploy button.";

type Get = typeof fetch;

async function read(doFetch: Get, path: string): Promise<Uint8Array> {
  let response: Response;
  try {
    response = await doFetch(path);
  } catch {
    throw new SetupError(NO_RELEASE);
  }
  if (!response.ok) throw new SetupError(NO_RELEASE, response.status);
  return new Uint8Array(await response.arrayBuffer());
}

/** The latest release's manifest, checked against the hash `latest.json` holds. */
export async function loadManifest(doFetch: Get = (input, init) => fetch(input, init)): Promise<ReleaseManifest> {
  let latest: { version?: unknown; manifestSha256?: unknown };
  try {
    latest = JSON.parse(new TextDecoder().decode(await read(doFetch, `${RELEASE_ROOT}/latest.json`))) as typeof latest;
  } catch (error) {
    if (error instanceof SetupError) throw error;
    throw new SetupError(NO_RELEASE);
  }
  if (typeof latest.version !== "string" || !/^[0-9A-Za-z.+-]{1,40}$/.test(latest.version) || typeof latest.manifestSha256 !== "string") {
    throw new SetupError(NO_RELEASE);
  }
  const bytes = await read(doFetch, `${RELEASE_ROOT}/${latest.version}/manifest.json`);
  if ((await sha256Hex(bytes)) !== latest.manifestSha256) throw new SetupError("The VEMI files did not match their list. Try again in a minute.");
  try {
    const manifest = JSON.parse(new TextDecoder().decode(bytes)) as ReleaseManifest;
    if (manifest.format !== 1 || manifest.version !== latest.version) throw new Error("format");
    return manifest;
  } catch {
    throw new SetupError("The VEMI files did not match their list. Try again in a minute.");
  }
}

/** Reads `items` with a few at a time, in order. */
async function inBatches<T, R>(items: readonly T[], size: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  let next = 0;
  const lanes = Array.from({ length: Math.min(size, items.length) }, async () => {
    for (;;) {
      const at = next++;
      if (at >= items.length) return;
      out[at] = await work(items[at] as T);
    }
  });
  await Promise.all(lanes);
  return out;
}

const LANES = 12;

/** Every file of the release, read and held to the manifest. `progress` gets files done and files in all. */
export async function loadBundle(
  manifest: ReleaseManifest,
  doFetch: Get = (input, init) => fetch(input, init),
  progress?: (done: number, total: number) => void,
): Promise<BuildBundle> {
  const base = `${RELEASE_ROOT}/${manifest.version}`;
  const total = manifest.client.length + manifest.migrations.length + 1;
  let done = 0;
  const tick = (): void => progress?.(++done, total);

  const worker: ReleaseFile = { path: manifest.worker.path, bytes: await read(doFetch, `${base}/${manifest.worker.path}`) };
  tick();
  const client = await inBatches(manifest.client, LANES, async (line) => {
    const file: ReleaseFile = { path: line.path, bytes: await read(doFetch, `${base}/${CLIENT_DIR}${line.path}`) };
    tick();
    return file;
  });
  const migrations = await inBatches(manifest.migrations, LANES, async (line) => {
    const file: ReleaseFile = { path: line.name, bytes: await read(doFetch, `${base}/${MIGRATIONS_DIR}/${line.name}`) };
    tick();
    return file;
  });

  const problems = await checkManifest(manifest, { worker, client, migrations });
  if (problems.length > 0) throw new SetupError("The VEMI files did not match their list. Try again in a minute.");
  return { manifest, worker, client, migrations };
}

/** A bundle with the manifest only, enough for the name check, which reads and sends no file. */
export function lightBundle(manifest: ReleaseManifest): BuildBundle {
  return { manifest, worker: { path: manifest.worker.path, bytes: new Uint8Array() }, client: [], migrations: [] };
}
