/**
 * The copy updating itself, in steps. The browser taps `start` once and then `step` until the answer
 * says done. Each step is one bounded piece of work, safe to repeat, and stays under 40 subrequests
 * (the Free plan allows 50): it looks for its own result before it makes it.
 *
 * Order: `files` (send the app files Cloudflare does not hold), `data` (run pending migrations, one a
 * request), `app` (upload the new Worker and deploy it). The restore point (the running version and
 * the database bookmark) is taken at `start`, before anything changes.
 *
 * What it refuses: a manifest whose signature or hash does not hold, a file that differs from its
 * signed hash (checked before it is sent), a release not newer than the running one, a copy with no
 * sealed key. The key is opened inside a step and held only in that step's local; it is never kept
 * between requests, logged or answered. Nothing here calls `console`. The route holds owner only.
 *
 * Also here: `back` (deploy the version the copy ran before, once, inside the seven days after an
 * update) and `off` (delete the sealed key). Going back changes the Worker only; data changes the
 * update made are not undone. Once the key is gone no step runs and nothing here puts one back.
 */
import { openToken } from "./setup.js";
import type { Store, UpdateRun } from "./store.js";
import {
  ASSETS_BINDING, CRON, DATA_BINDING, LIVE_BINDING, LIVE_CLASS, MIGRATION_TABLE, RUN_WORKER_FIRST, SAFE_MIGRATION, SetupError, contentTypeOf, createCloudflare, isNewer,
  safeBundlePath, toBase64, verifyManifest, type AssetFile, type Cloudflare, type FetchLike,
} from "@vemi/shared";
import { assetHash, assetKey, sha256Hex, type ManifestClientFile, type ReleaseManifest } from "../shared/setup/releaseManifest.js";

export const NOT_CHECKED = "This update could not be checked, so it was not installed.";
const NO_KEY = "This copy kept no key to update itself with.";

const TAG_PREFIX = "vemi:";
const FILES_PER_REQUEST = 20;
/** How long a step holds the run, as the store lets it go after a minute. */
const STEP_HOLD_MS = 60 * 1000;
const BACK_DAYS = 7;
/** A feed that has not answered by now is treated as unreachable, so a step never hangs on it. */
const FEED_TIMEOUT_MS = 20_000;
/** A migration file is plain SQL; one larger than this is not one of ours. */
const MAX_MIGRATION_BYTES = 1024 * 1024;
const ADDRESS = /^([a-z0-9][a-z0-9-]*)\.([a-z0-9][a-z0-9-]*)\.workers\.dev$/;
/** The steps in the order they run; `done` is where a finished run rests. */
const ORDER = ["files", "data", "app", "done"] as const;
type Next = (typeof ORDER)[number];

export interface SelfUpdateConfig {
  readonly store: Store;
  /** The `SETUP_CLAIM` secret the sealed key was sealed under. */
  readonly secret: string;
  /** The copy's own address; the sealing key depends on it and the Worker's name is read from it. */
  readonly origin: string;
  /** The absolute base of the release files, ending in a slash. */
  readonly feed: string;
  /** The Ed25519 public key releases are signed with, base64url. */
  readonly publicKey: string;
  /** The version the code running now is. */
  readonly version: string;
  /** Reaches the release feed and Cloudflare. */
  readonly fetch: FetchLike;
  readonly now: () => Date;
}

/** What a tap answers: a status and a JSON body. A refusal's body is `{ error, step? }`. */
export interface UpdateAnswer {
  readonly status: number;
  readonly body: Record<string, unknown>;
}

export interface SelfUpdate {
  /** Re-checks the stored release, finds the copy in Cloudflare, takes the restore point and opens the run. */
  start(): Promise<UpdateAnswer>;
  /** Does the next piece of the open run. */
  step(): Promise<UpdateAnswer>;
  /** Deploys the version the copy ran before the last update. Once, and only inside the seven days. */
  back(): Promise<UpdateAnswer>;
  /** Deletes the copy's sealed key, so it can no longer update itself. */
  off(): Promise<UpdateAnswer>;
}

export const OFF_SAID = "Key removed from this copy. Remove it in Cloudflare too.";
export const FORCED_SAID = "A secret changed since that version was made, so it was put back anyway. The earlier version now uses the secret as it is today.";
/** Cloudflare's refusal of an older version names the secret that changed. */
const CHANGED_SECRET = /secret/i;
/** A run that was updated and then gone back from rests in this state. */
export const BACK_STATE = "back";

class Stop extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

interface Outcome {
  readonly next: Next;
  readonly remaining: number;
  readonly migrated?: number;
  readonly newVersionId?: string | null;
  readonly backUntil?: string | null;
}

const encoder = new TextEncoder();
const progressOf = (step: Next): number => ORDER.indexOf(step) / (ORDER.length - 1);
const isStep = (step: string): step is Next => (ORDER as readonly string[]).includes(step);

export function createSelfUpdate(config: SelfUpdateConfig): SelfUpdate {
  const { store } = config;

  const answer = (next: Next, remaining: number, ran: string = next): UpdateAnswer => ({
    status: 200,
    body: { step: ran, done: next === "done", remaining, progress: progressOf(next) },
  });
  const refuse = (status: number, error: string, step?: string): UpdateAnswer => ({
    status,
    body: step === undefined ? { error } : { error, step },
  });

  /** The offer held in the store, re-verified against the key built into this copy. */
  async function verifiedOffer(): Promise<ReleaseManifest> {
    const offer = (await store.updateCheck())?.offer ?? null;
    if (offer === null) throw new Stop(409, "There is no update to install.");
    const verified = await verifyManifest(encoder.encode(offer.manifest), offer.signature, config.publicKey);
    if (!verified.ok) throw new Stop(422, verified.error);
    if (verified.manifest.version !== offer.version) throw new Stop(422, NOT_CHECKED);
    return verified.manifest;
  }

  /** Opens the sealed key and makes the client. The key lives only in the caller's frame. */
  async function openApi(): Promise<Cloudflare> {
    const claim = await store.setupClaim();
    if (claim === null || claim.sealedToken === null) throw new Stop(409, NO_KEY);
    const token = await openToken(claim.sealedToken, config.secret, config.origin);
    if (token === null) throw new Stop(409, "The key kept for updating could not be opened.");
    return createCloudflare({ fetch: config.fetch, token });
  }

  /** One file from the release. `size` is the signed size, or null for a file the manifest gives no size for. */
  async function fromFeed(version: string, path: string, size: number | null): Promise<Uint8Array> {
    if (config.feed === "") throw new Stop(409, "This copy has no release feed to update from.");
    if (!safeBundlePath(path)) throw new Stop(422, NOT_CHECKED);
    let res: Response;
    try {
      res = await config.fetch(`${config.feed}${version}/${path}`, { method: "GET", redirect: "follow", credentials: "omit", signal: AbortSignal.timeout(FEED_TIMEOUT_MS) } as RequestInit);
    } catch {
      throw new Stop(502, "The release files could not be reached.");
    }
    if (res.status !== 200) throw new Stop(502, "The release files could not be read.");
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (size !== null ? bytes.length !== size : bytes.length > MAX_MIGRATION_BYTES) throw new Stop(422, NOT_CHECKED);
    return bytes;
  }

  const clientPath = (file: ManifestClientFile): string => `client/${file.path.replace(/^\//, "")}`;

  /** The asset manifest Cloudflare is told, and each file by its Cloudflare key. */
  function assetsOf(manifest: ReleaseManifest) {
    const sent: Record<string, { hash: string; size: number }> = {};
    const byKey = new Map<string, ManifestClientFile>();
    for (const file of manifest.client) {
      const key = assetKey(file.assetHash);
      sent[file.path] = { hash: key, size: file.size };
      byKey.set(key, file);
    }
    return { sent, byKey };
  }

  function placeOf(run: UpdateRun): { accountId: string; databaseId: string; workerName: string } {
    if (run.accountId === null || run.databaseId === null || run.workerName === null) throw new Stop(409, "The update was not started properly. Start it again.");
    return { accountId: run.accountId, databaseId: run.databaseId, workerName: run.workerName };
  }

  /** Sends what Cloudflare does not hold, at most 20 files a request. */
  async function filesStep(run: UpdateRun, manifest: ReleaseManifest, api: Cloudflare): Promise<Outcome> {
    const { accountId, workerName } = placeOf(run);
    const { sent, byKey } = assetsOf(manifest);
    const session = await api.startAssets(accountId, workerName, sent);
    const pending = session.buckets.reduce((sum, bucket) => sum + bucket.length, 0);
    if (pending === 0) return { next: "data", remaining: 0 };

    // The first 20 hashes Cloudflare asked for, kept in the buckets it asked for them in.
    const groups: string[][] = [];
    let taken = 0;
    for (const bucket of session.buckets) {
      if (taken >= FILES_PER_REQUEST) break;
      const part = bucket.slice(0, FILES_PER_REQUEST - taken);
      groups.push(part);
      taken += part.length;
    }

    // Every file is read and held to its signed hash before any is sent.
    const ready: AssetFile[][] = [];
    for (const group of groups) {
      const batch: AssetFile[] = [];
      for (const hash of group) {
        const file = byKey.get(hash);
        if (file === undefined) throw new Stop(502, "Cloudflare asked for an app file that is not in this release.");
        const bytes = await fromFeed(manifest.version, clientPath(file), file.size);
        if ((await assetHash({ path: file.path, bytes })) !== file.assetHash) throw new Stop(422, NOT_CHECKED);
        batch.push({ hash, contentType: contentTypeOf(file.path), base64: toBase64(bytes) });
      }
      ready.push(batch);
    }
    let completion: string | null = null;
    for (const batch of ready) completion = (await api.uploadAssets(accountId, session.jwt, batch)) ?? completion;

    const remaining = pending - taken;
    return { next: remaining === 0 && completion !== null ? "data" : "files", remaining };
  }

  /** Runs the first migration the database has not recorded, after checking its signed hash. */
  async function dataStep(run: UpdateRun, manifest: ReleaseManifest, api: Cloudflare): Promise<Outcome> {
    const { accountId, databaseId } = placeOf(run);
    const applied = new Set((await api.query(accountId, databaseId, `SELECT name FROM ${MIGRATION_TABLE} ORDER BY id;`)).map((row) => String(row["name"])));
    const pending = manifest.migrations.filter((line) => !applied.has(line.name));
    const line = pending[0];
    if (line === undefined) return { next: "app", remaining: 0 };
    if (!SAFE_MIGRATION.test(line.name)) throw new Stop(422, NOT_CHECKED);
    const bytes = await fromFeed(manifest.version, `migrations/${line.name}`, null);
    if ((await sha256Hex(bytes)) !== line.sha256) throw new Stop(422, NOT_CHECKED);
    const sql = new TextDecoder().decode(bytes).trimEnd();
    try {
      // The body and its record go in one call, so a migration is never applied without being recorded.
      await api.query(accountId, databaseId, `${sql}${sql.endsWith(";") ? "" : "\n;"}\nINSERT INTO ${MIGRATION_TABLE} (name) VALUES ('${line.name}');`);
    } catch (error) {
      if (error instanceof SetupError) throw new Stop(502, `The migration ${line.name} did not run. ${error.message}`);
      throw error;
    }
    const remaining = pending.length - 1;
    return { next: remaining === 0 ? "app" : "data", remaining, migrated: run.migrated + 1 };
  }

  /** Uploads the new Worker with the bindings the setup made, keeps secrets and variables, and deploys. */
  async function appStep(run: UpdateRun, manifest: ReleaseManifest, api: Cloudflare): Promise<Outcome> {
    const { accountId, databaseId, workerName } = placeOf(run);
    const tag = `${TAG_PREFIX}${manifest.version}`;
    const tags = await api.getWorkerTags(accountId, workerName);
    if (tags === null) throw new Stop(502, "The app to update is not there.");

    let newVersionId: string | null = run.newVersionId;
    let before: string[] = [];
    if (!tags.includes(tag)) {
      const bytes = await fromFeed(manifest.version, manifest.worker.path, manifest.worker.size);
      if ((await sha256Hex(bytes)) !== manifest.worker.sha256) throw new Stop(422, NOT_CHECKED);

      // Every file must be held by Cloudflare before the Worker that names them goes up.
      const session = await api.startAssets(accountId, workerName, assetsOf(manifest).sent);
      const missing = session.buckets.reduce((sum, bucket) => sum + bucket.length, 0);
      if (missing > 0) return { next: "files", remaining: missing };

      const moduleName = manifest.worker.path.slice(manifest.worker.path.lastIndexOf("/") + 1);
      const metadata: Record<string, unknown> = {
        main_module: moduleName,
        compatibility_date: manifest.compatibilityDate,
        tags: [tag],
        bindings: [
          { type: "d1", name: DATA_BINDING, id: databaseId },
          { type: "durable_object_namespace", name: LIVE_BINDING, class_name: LIVE_CLASS },
          { type: "assets", name: ASSETS_BINDING },
        ],
        assets: { jwt: session.jwt, config: { not_found_handling: "single-page-application", run_worker_first: RUN_WORKER_FIRST } },
      };
      // What the app holds now, by name, so a binding lost in the upload is found rather than assumed kept.
      const held = await api.getWorkerBindings(accountId, workerName);
      // No `migrations` field: the live-room class was made by the first upload and never changes in an update.
      newVersionId = await api.uploadWorker(accountId, workerName, {
        metadata, moduleName, module: new TextDecoder().decode(bytes), keepBindings: ["secret_text", "plain_text"],
      });
      before = (held ?? []).map((binding) => binding.name);
    }

    // The deployed app must still hold what it held before the upload, and what the copy cannot run without.
    // Looked at on every pass, so a step that stopped here and is tapped again looks again.
    const holds = new Set(((await api.getWorkerBindings(accountId, workerName)) ?? []).map((binding) => binding.name));
    const needed = [...before, DATA_BINDING, LIVE_BINDING, ASSETS_BINDING, "SETUP_CLAIM"];
    const lost = [...new Set(needed)].filter((name) => !holds.has(name));
    if (lost.length > 0) throw new Stop(502, `The update left ${lost.join(", ")} out of the app, so check the app in Cloudflare or go back.`);
    if (newVersionId === null) newVersionId = (await api.getDeployment(accountId, workerName))?.versionId ?? null;

    // The cron and the address belong to the Worker, not to an upload; look, and set only what is missing.
    if ((await api.getSchedules(accountId, workerName)).length === 0) await api.setSchedules(accountId, workerName, [CRON]);
    if (!(await api.getWorkersDev(accountId, workerName))) await api.setWorkersDev(accountId, workerName, true);

    const backUntil = run.backUntil ?? new Date(config.now().getTime() + BACK_DAYS * 86_400_000).toISOString();
    return { next: "done", remaining: 0, newVersionId, backUntil };
  }

  /** A run left untouched for a day is not holding the way. */
  const lapsed = (run: UpdateRun): boolean => config.now().getTime() - Date.parse(run.updatedAt) > 24 * 60 * 60 * 1000;

  const stepsOf = { files: filesStep, data: dataStep, app: appStep } as const;

  /** What a thrown thing says, as an answer that names the step. */
  function failure(error: unknown, step: string): UpdateAnswer {
    if (error instanceof Stop) return refuse(error.status, error.message, step);
    if (error instanceof SetupError) return refuse(502, error.message, step);
    return refuse(500, "Something went wrong during the update.", step);
  }

  return {
    async start() {
      try {
        const claim = await store.setupClaim();
        if (claim === null || claim.sealedToken === null) throw new Stop(409, NO_KEY);
        const manifest = await verifiedOffer();
        if (!isNewer(manifest.version, config.version)) throw new Stop(409, "That update is not newer than this copy.");

        const existing = await store.updateRun();
        const resting = existing === null || existing.state === "done" || existing.state === BACK_STATE;
        if (existing !== null && existing.version === manifest.version && existing.state !== BACK_STATE) {
          return answer(existing.state === "done" || !isStep(existing.step) ? "done" : existing.step, 0, "start");
        }
        // A run for another version that no step is working on is replaced, so a newer release replacing the offer
        // never leaves the owner waiting out the day. Only a step in flight holds the way.
        const inFlight = existing !== null && existing.state === "busy" && config.now().getTime() - Date.parse(existing.updatedAt) <= STEP_HOLD_MS;
        if (inFlight) throw new Stop(409, "Another update is already under way.");
        const replacing = existing !== null && !resting && !lapsed(existing) ? existing : null;

        const match = ADDRESS.exec(new URL(config.origin).hostname);
        if (match === null) throw new Stop(409, "This copy's address is not one the updater can read, so it cannot update itself.");
        const workerName = match[1]!;

        const api = await openApi();
        let accountId: string | null = null;
        for (const account of await api.listAccounts()) {
          if ((await api.getWorkerTags(account.id, workerName))?.some((tag) => tag.startsWith(TAG_PREFIX))) {
            accountId = account.id;
            break;
          }
        }
        if (accountId === null) throw new Stop(409, "This copy's app was not found in the account the key reaches.");
        const database = await api.findDatabase(accountId, workerName);
        if (database === null) throw new Stop(409, "This copy's database was not found in the account the key reaches.");
        const deployment = await api.getDeployment(accountId, workerName);
        const bookmark = await api.getBookmark(accountId, database.id);

        const at = config.now().toISOString();
        // A replaced run keeps the restore point it took before anything changed: the running version now may
        // already be the one it put up, and the bookmark now is after its data changes.
        const run = {
          version: manifest.version, step: "files", state: "running", accountId, databaseId: database.id, workerName,
          previousVersionId: replacing?.previousVersionId ?? deployment?.versionId ?? null,
          previousVersion: replacing === null ? config.version : replacing.previousVersion,
          newVersionId: null, bookmark: replacing?.bookmark ?? bookmark, migrated: replacing?.migrated ?? 0, startedAt: replacing?.startedAt ?? at, backUntil: null,
        };
        const started = replacing === null ? await store.openUpdateRun(run) : (await store.keepUpdateRun(run), true);
        if (!started) {
          // Another tap opened it first.
          const now = await store.updateRun();
          if (now !== null && now.version === manifest.version) return answer(isStep(now.step) ? now.step : "files", 0, "start");
          throw new Stop(409, "Another update is already under way.");
        }
        return answer("files", manifest.client.length, "start");
      } catch (error) {
        return failure(error, "start");
      }
    },

    async step() {
      const run = await store.updateRun();
      if (run === null) return refuse(409, "No update has been started.");
      if (run.step === "done" || run.state === "done" || !isStep(run.step) || run.step === "done") return answer("done", 0);
      const name = run.step as Exclude<Next, "done">;
      // One caller at a time: a second tap while a step runs sees the run as it stands.
      if (!(await store.takeUpdateStep(name))) return answer(name, 0, name);
      try {
        const manifest = await verifiedOffer();
        if (manifest.version !== run.version) throw new Stop(409, "That update is no longer offered.");
        const api = await openApi();
        const out = await stepsOf[name](run, manifest, api);
        await store.keepUpdateRun({
          ...run, step: out.next, state: out.next === "done" ? "done" : "running", migrated: out.migrated ?? run.migrated,
          newVersionId: out.newVersionId === undefined ? run.newVersionId : out.newVersionId,
          backUntil: out.backUntil === undefined ? run.backUntil : out.backUntil,
        });
        return answer(out.next, out.remaining, name);
      } catch (error) {
        // The hold is let go, and the run says which step stopped.
        await store.keepUpdateRun({ ...run, state: "failed" });
        return failure(error, name);
      }
    },

    async back() {
      try {
        const run = await store.updateRun();
        if (run === null || run.step !== "done") throw new Stop(409, "There is no update to go back from.");
        if (run.state === BACK_STATE) throw new Stop(409, "This copy has already gone back once.");
        if (run.previousVersionId === null) throw new Stop(409, "No earlier version was kept, so there is nothing to go back to.");
        if (run.backUntil === null || run.backUntil <= config.now().toISOString()) throw new Stop(409, "The seven days for going back have passed.");
        const { accountId, workerName } = placeOf(run);
        // One caller at a time: a second tap sees the run held and is refused.
        if (!(await store.takeUpdateStep("done"))) throw new Stop(409, "Going back is already under way.");
        let forced = false;
        try {
          const api = await openApi();
          try {
            await api.deployVersion(accountId, workerName, run.previousVersionId);
          } catch (error) {
            // Cloudflare refuses an older version when a secret changed since it was made. The owner asked to go back,
            // so it is asked once more with force, and the answer says so. Any other refusal is not forced.
            if (!(error instanceof SetupError) || !CHANGED_SECRET.test(error.message)) throw error;
            forced = true;
            await api.deployVersion(accountId, workerName, run.previousVersionId, { force: true });
          }
        } catch (error) {
          await store.keepUpdateRun({ ...run, state: "done" });
          throw error;
        }
        await store.keepUpdateRun({ ...run, state: BACK_STATE });
        // The release that was gone back from is looked for again at the next hour.
        await store.expireUpdateCheck();
        return {
          status: 200,
          body: forced
            ? { back: true, version: run.previousVersion, forced: true, said: FORCED_SAID }
            : { back: true, version: run.previousVersion },
        };
      } catch (error) {
        return failure(error, "back");
      }
    },

    async off() {
      const claim = await store.setupClaim();
      if (claim === null || claim.sealedToken === null) return refuse(409, "This copy has no key kept to remove.");
      await store.removeSetupKey();
      return { status: 200, body: { off: true, said: OFF_SAID } };
    },
  };
}

