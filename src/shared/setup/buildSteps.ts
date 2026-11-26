/**
 * The six build steps: Database, Data layout, App files, App, Reminder clock, Address. Each one
 * first looks for its own result and makes it only when it is missing, so a rerun after a failure
 * (or a second run on a finished copy) changes nothing. Each answers `done` or one sentence.
 *
 * The steps shape one Cloudflare account through `Cloudflare` (cloudflareApi.ts) and nothing else:
 * no request leaves this folder except through the `fetch` that client was given.
 */
import { SetupError, type AssetFile, type Cloudflare } from "./cloudflareApi.js";
import { assetHash, assetKey, type ReleaseFile, type ReleaseManifest } from "./releaseManifest.js";

export const STEP_NAMES = ["Database", "Data layout", "App files", "App", "Reminder clock", "Address"] as const;
export type StepName = (typeof STEP_NAMES)[number];

/** What the copy's Worker is built to. The drift test holds these to wrangler.jsonc. */
export const OWNER_ID = "owner";
export const DEFAULT_TIME_ZONE = "UTC";
export const CRON = "* * * * *";
export const RUN_WORKER_FIRST = ["/api/*", "/auth/*", "/mcp", "/oauth/*", "/.well-known/*", "/setup/*"];
/** The binding name the build gives a new copy's Worker. Named here only to set it; no data is read through it (tests/d1-one-file.test.ts holds the one exemption). */
export const DATA_BINDING = "DB";
export const LIVE_BINDING = "LIVE";
export const LIVE_CLASS = "Live";
export const ASSETS_BINDING = "ASSETS";
export const MIGRATION_TAG = "v1";
/** The record of applied migrations; the same table Wrangler keeps, so a later deploy agrees with it. */
export const MIGRATION_TABLE = "d1_migrations";
const TAG_PREFIX = "vemi:";

/** The files of one release, read from `dist/release/<version>/`. */
export interface BuildBundle {
  manifest: ReleaseManifest;
  worker: ReleaseFile;
  client: ReleaseFile[];
  migrations: ReleaseFile[];
}

export interface BuildPlan {
  api: Cloudflare;
  accountId: string;
  /** The copy's name: its Worker and its database. */
  name: string;
  /** The account's workers.dev name if it has none yet; defaults to `name`. */
  subdomain?: string;
  /** The page's own origin; the copy lets this origin hand over the key, and no other. */
  from: string;
  /** The one-time claim code, from `newClaimCode()`. */
  claim: string;
  bundle: BuildBundle;
  timeZone?: string;
  /** One line per event. Never holds the key. */
  log?: (line: string) => void;
}

export type StepResult = { state: "done" } | { state: "failed"; reason: string };

export interface Step {
  name: StepName;
  run(): Promise<StepResult>;
}

export type BuildOutcome =
  | { ok: true; address: string; done: StepName[] }
  | { ok: false; step: StepName; reason: string; done: StepName[] };

export type Preflight = { ok: true; address: string | null } | { ok: false; reason: string };

const NAME_RULE = /^[a-z0-9][a-z0-9-]{0,61}[a-z0-9]$|^[a-z0-9]$/;

/** A sentence about a name Cloudflare would not take, or null when the name is fine. */
export function copyNameProblem(name: string): string | null {
  return NAME_RULE.test(name) ? null : "A name uses lowercase letters, numbers and dashes, and starts and ends with a letter or number.";
}

/** A fresh one-time claim code: 24 random bytes as 32 URL-safe characters. */
export function newClaimCode(random: (length: number) => Uint8Array = (n) => crypto.getRandomValues(new Uint8Array(n))): string {
  let binary = "";
  for (const byte of random(24)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_");
}

const CONTENT_TYPES: Record<string, string> = {
  html: "text/html",
  js: "application/javascript",
  mjs: "application/javascript",
  css: "text/css",
  json: "application/json",
  webmanifest: "application/manifest+json",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  ico: "image/x-icon",
  woff: "font/woff",
  woff2: "font/woff2",
  txt: "text/plain",
  map: "application/json",
};

export function contentTypeOf(path: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return (dot > 0 ? CONTENT_TYPES[name.slice(dot + 1).toLowerCase()] : undefined) ?? "application/octet-stream";
}

export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) binary += String.fromCharCode(...bytes.subarray(i, i + step));
  return btoa(binary);
}

export const SAFE_MIGRATION = /^\d{4}_[A-Za-z0-9_]+\.sql$/;

export function createBuild(plan: BuildPlan) {
  const { api, accountId, name, bundle } = plan;
  const say = (line: string): void => plan.log?.(line);
  const version = bundle.manifest.version;
  const tag = `${TAG_PREFIX}${version}`;
  const moduleName = bundle.worker.path.slice(bundle.worker.path.lastIndexOf("/") + 1);

  /** What the run has learned so far; a step skipped on a resume refetches what it needs. */
  const state: { databaseId?: string; assetsJwt?: string; address?: string } = {};

  async function databaseId(): Promise<string> {
    if (state.databaseId) return state.databaseId;
    const found = await api.findDatabase(accountId, name);
    if (!found) throw new SetupError("The database is not there yet.");
    state.databaseId = found.id;
    return found.id;
  }

  /** Opens an upload session and sends what Cloudflare does not hold; answers the completion key. */
  async function assetsKey(): Promise<string> {
    if (state.assetsJwt) return state.assetsJwt;
    const files = new Map<string, { file: ReleaseFile; hash: string }>();
    const manifest: Record<string, { hash: string; size: number }> = {};
    for (const file of bundle.client) {
      const hash = assetKey(await assetHash(file));
      files.set(hash, { file, hash });
      manifest[file.path] = { hash, size: file.bytes.length };
    }
    const session = await api.startAssets(accountId, name, manifest);
    let completion = session.buckets.length === 0 ? session.jwt : null;
    for (const bucket of session.buckets) {
      const batch: AssetFile[] = bucket.map((hash) => {
        const entry = files.get(hash);
        if (!entry) throw new SetupError("Cloudflare asked for an app file that is not in this release.");
        return { hash, contentType: contentTypeOf(entry.file.path), base64: toBase64(entry.file.bytes) };
      });
      completion = (await api.uploadAssets(accountId, session.jwt, batch)) ?? completion;
    }
    if (completion === null) throw new SetupError("Cloudflare did not confirm the app files.");
    state.assetsJwt = completion;
    return completion;
  }

  async function deployedAtThisVersion(): Promise<{ tags: string[] | null; here: boolean }> {
    const tags = await api.getWorkerTags(accountId, name);
    return { tags, here: tags?.includes(tag) === true };
  }

  const database: Step = {
    name: "Database",
    async run() {
      const found = await api.findDatabase(accountId, name);
      const made = found ?? (await api.createDatabase(accountId, name));
      state.databaseId = made.id;
      return { state: "done" };
    },
  };

  const layout: Step = {
    name: "Data layout",
    async run() {
      const id = await databaseId();
      await api.query(
        accountId,
        id,
        `CREATE TABLE IF NOT EXISTS ${MIGRATION_TABLE} (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP);`,
      );
      const applied = new Set((await api.query(accountId, id, `SELECT name FROM ${MIGRATION_TABLE} ORDER BY id;`)).map((row) => String(row["name"])));
      const decoder = new TextDecoder();
      for (const line of bundle.manifest.migrations) {
        if (applied.has(line.name)) continue;
        if (!SAFE_MIGRATION.test(line.name)) throw new SetupError(`The migration ${line.name} has a name the build will not run.`);
        const file = bundle.migrations.find((f) => f.path === line.name);
        if (!file) throw new SetupError(`The migration ${line.name} is listed but missing from this release.`);
        const sql = decoder.decode(file.bytes).trimEnd();
        // The body and its record go in one call, so a migration is never applied without being recorded.
        await api.query(accountId, id, `${sql}${sql.endsWith(";") ? "" : "\n;"}\nINSERT INTO ${MIGRATION_TABLE} (name) VALUES ('${line.name}');`);
        say(`Data layout: applied ${line.name}`);
      }
      return { state: "done" };
    },
  };

  const files: Step = {
    name: "App files",
    async run() {
      // A Worker already deployed at this version holds its files; there is nothing to send.
      if ((await deployedAtThisVersion()).here) return { state: "done" };
      await assetsKey();
      return { state: "done" };
    },
  };

  const app: Step = {
    name: "App",
    async run() {
      const { tags, here } = await deployedAtThisVersion();
      if (here) return { state: "done" };
      const id = await databaseId();
      const jwt = await assetsKey();
      const metadata: Record<string, unknown> = {
        main_module: moduleName,
        compatibility_date: bundle.manifest.compatibilityDate,
        tags: [tag],
        bindings: [
          { type: "d1", name: DATA_BINDING, id },
          { type: "durable_object_namespace", name: LIVE_BINDING, class_name: LIVE_CLASS },
          { type: "assets", name: ASSETS_BINDING },
          { type: "plain_text", name: "OWNER", text: OWNER_ID },
          { type: "plain_text", name: "TIME_ZONE", text: plan.timeZone ?? DEFAULT_TIME_ZONE },
          { type: "plain_text", name: "SETUP_FROM", text: plan.from },
          { type: "secret_text", name: "SETUP_CLAIM", text: plan.claim },
        ],
        assets: { jwt, config: { not_found_handling: "single-page-application", run_worker_first: RUN_WORKER_FIRST } },
      };
      // The live-room class is made once, with the first upload; a Worker that exists already has it.
      if (tags === null) metadata["migrations"] = { new_tag: MIGRATION_TAG, steps: [{ new_sqlite_classes: [LIVE_CLASS] }] };
      await api.uploadWorker(accountId, name, { metadata, moduleName, module: new TextDecoder().decode(bundle.worker.bytes) });
      return { state: "done" };
    },
  };

  const clock: Step = {
    name: "Reminder clock",
    async run() {
      const set = await api.getSchedules(accountId, name);
      if (set.length === 1 && set[0] === CRON) return { state: "done" };
      await api.setSchedules(accountId, name, [CRON]);
      return { state: "done" };
    },
  };

  async function addressOf(subdomain: string): Promise<string> {
    return `https://${name}.${subdomain}.workers.dev`;
  }

  const address: Step = {
    name: "Address",
    async run() {
      let subdomain = await api.getSubdomain(accountId);
      if (subdomain === null) subdomain = await api.setSubdomain(accountId, plan.subdomain ?? name);
      if (!(await api.getWorkersDev(accountId, name))) await api.setWorkersDev(accountId, name, true);
      state.address = await addressOf(subdomain);
      return { state: "done" };
    },
  };

  const steps: Step[] = [database, layout, files, app, clock, address];

  /** Looks for a clash before anything is made; reads only. */
  async function preflight(): Promise<Preflight> {
    const bad = copyNameProblem(name);
    if (bad) return { ok: false, reason: bad };
    const tags = await api.getWorkerTags(accountId, name);
    if (tags !== null && !tags.some((t) => t.startsWith(TAG_PREFIX))) {
      return { ok: false, reason: `This account already has an app called ${name} that VEMI did not make.` };
    }
    const found = await api.findDatabase(accountId, name);
    if (found && tags === null) {
      const tables = await api.query(
        accountId,
        found.id,
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%';",
      );
      const names = tables.map((row) => String(row["name"]));
      if (names.length > 0 && !names.includes(MIGRATION_TABLE)) {
        return { ok: false, reason: `This account already has a database called ${name} that VEMI did not make.` };
      }
    }
    const subdomain = await api.getSubdomain(accountId);
    return { ok: true, address: await addressOf(subdomain ?? plan.subdomain ?? name) };
  }

  /**
   * Runs the steps in order, stopping at the first failure. A step named in `done` is skipped with
   * no request at all; the rest each check for their own result first.
   */
  async function run(done: readonly StepName[] = [], onStep?: (step: StepName, state: "start" | "skipped" | "done" | "failed") => void): Promise<BuildOutcome> {
    const finished: StepName[] = [];
    for (const step of steps) {
      if (done.includes(step.name)) {
        finished.push(step.name);
        onStep?.(step.name, "skipped");
        say(`${step.name}: skipped`);
        continue;
      }
      onStep?.(step.name, "start");
      say(`${step.name}: start`);
      let result: StepResult;
      try {
        result = await step.run();
      } catch (error) {
        const reason = error instanceof SetupError ? error.message : `Something went wrong at ${step.name}.`;
        result = { state: "failed", reason };
      }
      if (result.state === "failed") {
        say(`${step.name}: failed`);
        onStep?.(step.name, "failed");
        return { ok: false, step: step.name, reason: result.reason, done: finished };
      }
      finished.push(step.name);
      say(`${step.name}: done`);
      onStep?.(step.name, "done");
    }
    if (state.address === undefined) {
      const subdomain = await api.getSubdomain(accountId);
      state.address = await addressOf(subdomain ?? plan.subdomain ?? name);
    }
    return { ok: true, address: state.address, done: finished };
  }

  return { steps, preflight, run };
}
