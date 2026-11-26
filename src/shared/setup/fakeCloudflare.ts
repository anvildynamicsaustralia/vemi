/**
 * An in-memory Cloudflare for the setup tests: it answers the calls cloudflareApi.ts makes, keeps
 * what was made, and records every request. Test support only; the app and the relay never
 * import it (a test holds that). Its fake keys are short strings, never a real shape.
 *
 * Failures are injected by call label (`database.create`, `worker.upload`, ...) with `failOnce`.
 * A label is also what `mutations()` lists: the calls that change something. Reads and the upload
 * session are not mutations, so "a second run makes no create or upload call" is
 * `mutations().length === 0`.
 */
import { CLOUDFLARE_BASE } from "./cloudflareApi.js";

export interface FakeRequest {
  method: string;
  /** The path after the API base, query included. */
  path: string;
  /** Which kind of credential the call carried; the value itself is never recorded. */
  credential: "key" | "upload" | "none";
  label: string;
  mutation: boolean;
}

export interface FakeWorker {
  metadata: Record<string, any>;
  moduleName: string;
  module: string;
  schedules: string[];
  workersDev: boolean;
  /** The bindings the running version holds: the ones sent, plus those kept from the version before. */
  bindings: FakeBinding[];
  /** The version serving traffic. */
  versionId: string;
}

export interface FakeBinding {
  name: string;
  type: string;
  [key: string]: unknown;
}

export interface FakeVersion {
  id: string;
  number: number;
  metadata: Record<string, any>;
  moduleName: string;
  module: string;
  bindings: FakeBinding[];
  /** The asset hashes this version's manifest holds. */
  assets: string[];
  /** An expired version is gone from the list and cannot be deployed. */
  expired: boolean;
}

export interface FakeDeployment {
  id: string;
  created_on: string;
  versions: { version_id: string; percentage: number }[];
  forced: boolean;
}

export interface FakeDatabase {
  id: string;
  name: string;
  tables: Set<string>;
  /** Changes with every write, so a bookmark names a moment in the data. */
  writes: number;
  applied: string[];
  /** The text of every migration run, in order. */
  migrationSql: string[];
}

export interface FakeOptions {
  /** The key the fake accepts. */
  token: string;
  /** Other keys of the same account that are also accepted, as when a resumed setup is given a second key. */
  alsoAccepts?: readonly string[];
  accountId?: string;
  accountName?: string;
  subdomain?: string | null;
}

interface Injected {
  label: string;
  status: number;
  message: string;
}

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const ok = (result: unknown, status = 200): Response => json(status, { success: true, errors: [], messages: [], result });

const bad = (status: number, message: string): Response =>
  json(status, { success: false, errors: [{ code: 1000, message }], messages: [], result: null });

/** Hashes go to Cloudflare in buckets this size, so more than one bucket is exercised. */
const BUCKET = 2;

export function createFakeCloudflare(options: FakeOptions) {
  const accountId = options.accountId ?? "acct-test";
  const accountName = options.accountName ?? "Test account";
  let subdomain: string | null = options.subdomain === undefined ? "test-sub" : options.subdomain;

  const requests: FakeRequest[] = [];
  const log: string[] = [];
  const databases = new Map<string, FakeDatabase>();
  const workers = new Map<string, FakeWorker>();
  const held = new Map<string, string>();
  const sessions = new Map<string, { pending: Set<string>; wanted: string[] }>();
  /** A completion key and the hashes its upload covered. */
  const completions = new Map<string, string[]>();
  const versions = new Map<string, FakeVersion[]>();
  /** Newest first, as Cloudflare lists them. */
  const deployments = new Map<string, FakeDeployment[]>();
  const injected: Injected[] = [];
  /** Binding names Cloudflare loses on uploads, as a fault to test against. */
  const lost = new Set<string>();
  let counter = 0;
  const next = (prefix: string): string => `${prefix}-${++counter}`;

  function failOnce(label: string, status = 500, message = "internal error"): void {
    injected.push({ label, status, message });
  }

  function seedDatabase(name: string, tables: string[]): FakeDatabase {
    const db: FakeDatabase = { id: next("db"), name, tables: new Set(tables), writes: 0, applied: [], migrationSql: [] };
    databases.set(db.id, db);
    return db;
  }

  /** Makes a version of a Worker and answers it; it is not deployed until `deploy`. */
  function makeVersion(name: string, metadata: Record<string, any>, moduleName: string, module: string, bindings: FakeBinding[], assets: string[]): FakeVersion {
    const list = versions.get(name) ?? [];
    const version: FakeVersion = { id: next("ver"), number: list.length + 1, metadata, moduleName, module, bindings, assets, expired: false };
    versions.set(name, [version, ...list]);
    return version;
  }

  function deploy(name: string, version: FakeVersion, forced = false): FakeDeployment {
    const deployment: FakeDeployment = { id: next("dep"), created_on: new Date(counter * 1000).toISOString(), versions: [{ version_id: version.id, percentage: 100 }], forced };
    deployments.set(name, [deployment, ...(deployments.get(name) ?? [])]);
    const worker = workers.get(name);
    if (worker) {
      worker.metadata = version.metadata;
      worker.moduleName = version.moduleName;
      worker.module = version.module;
      worker.bindings = version.bindings;
      worker.versionId = version.id;
    }
    return deployment;
  }

  function seedWorker(name: string, tags: string[], bindings: FakeBinding[] = []): void {
    const version = makeVersion(name, { tags }, "index.js", "", bindings, []);
    workers.set(name, { metadata: { tags }, moduleName: "index.js", module: "", schedules: [], workersDev: false, bindings, versionId: version.id });
    deploy(name, version);
  }

  /** A version Cloudflare no longer keeps: it leaves the list and cannot be deployed. */
  function expireVersion(id: string): void {
    for (const list of versions.values()) for (const version of list) if (version.id === id) version.expired = true;
  }

  /** The bookmark for a database as it stands: it names the number of writes made. */
  const bookmarkOf = (db: FakeDatabase): string => `bookmark-${db.id}-${db.writes}`;

  async function fetch(url: string, init: RequestInit = {}): Promise<Response> {
    if (!url.startsWith(CLOUDFLARE_BASE)) throw new Error(`the fake only answers ${CLOUDFLARE_BASE}`);
    const path = url.slice(CLOUDFLARE_BASE.length);
    const method = (init.method ?? "GET").toUpperCase();
    const headers = new Headers(init.headers);
    const auth = headers.get("authorization") ?? "";
    const bearer = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    const route = new URL(url);
    const parts = route.pathname.replace("/client/v4", "").split("/").filter(Boolean);
    const body = init.body;

    // Routes under /accounts/:a/...
    let label = "unknown";
    let mutation = false;
    const rest = parts[0] === "accounts" ? parts.slice(2) : parts;
    const joined = rest.join("/");
    const scriptName = rest[0] === "workers" && rest[1] === "scripts" ? decodeURIComponent(rest[2] ?? "") : "";
    if (parts[0] === "user") label = "token.verify";
    else if (parts[0] === "accounts" && parts.length === 1) label = "accounts.list";
    else if (joined === "workers/subdomain") [label, mutation] = method === "PUT" ? ["subdomain.set", true] : ["subdomain.get", false];
    else if (joined === "d1/database") [label, mutation] = method === "POST" ? ["database.create", true] : ["database.find", false];
    else if (rest[0] === "d1" && rest[3] === "query") label = "query";
    else if (rest[0] === "workers" && rest[1] === "assets" && rest[2] === "upload") [label, mutation] = ["assets.upload", true];
    else if (rest[3] === "assets-upload-session") label = "assets.session";
    else if (rest[3] === "settings") label = "worker.get";
    else if (rest.length === 3 && rest[1] === "scripts") [label, mutation] = ["worker.upload", true];
    else if (rest[0] === "workers" && rest[3] === "deployments") [label, mutation] = method === "POST" ? ["deployment.create", true] : ["deployment.get", false];
    else if (rest[0] === "workers" && rest[3] === "versions") label = "versions.list";
    else if (rest[0] === "d1" && rest[3] === "time_travel" && rest[4] === "bookmark") label = "bookmark.get";
    else if (rest[3] === "schedules") [label, mutation] = method === "PUT" ? ["schedules.set", true] : ["schedules.get", false];
    else if (rest[3] === "subdomain") [label, mutation] = method === "POST" ? ["workers-dev.set", true] : ["workers-dev.get", false];

    const credential: FakeRequest["credential"] = bearer === "" ? "none" : label === "assets.upload" ? "upload" : "key";
    let record: FakeRequest = { method, path, credential, label, mutation };
    const finish = (response: Response): Response => {
      requests.push(record);
      log.push(`${method} ${path} ${response.status}`);
      return response;
    };

    const failure = injected.findIndex((entry) => entry.label === label);
    if (failure >= 0) {
      const [entry] = injected.splice(failure, 1);
      record = { ...record, mutation: false };
      return finish(bad(entry!.status, entry!.message));
    }

    if (label === "assets.upload") {
      if (!sessions.has(bearer)) return finish(bad(401, "bad upload key"));
    } else if (bearer !== options.token && !(options.alsoAccepts ?? []).includes(bearer)) {
      record = { ...record, mutation: false };
      return finish(bad(401, "Invalid API Token"));
    }
    if (parts[0] === "accounts" && parts[1] !== undefined && parts[1] !== accountId) {
      record = { ...record, mutation: false };
      return finish(bad(403, "not your account"));
    }

    const jsonBody = async (): Promise<any> => (typeof body === "string" ? JSON.parse(body) : null);

    switch (label) {
      case "token.verify":
        return finish(ok({ id: "tok-1", status: "active" }));
      case "accounts.list":
        return finish(ok([{ id: accountId, name: accountName }]));
      case "subdomain.get":
        return finish(subdomain === null ? bad(404, "no subdomain") : ok({ subdomain }));
      case "subdomain.set": {
        subdomain = (await jsonBody()).subdomain;
        return finish(ok({ subdomain }));
      }
      case "database.find": {
        const name = route.searchParams.get("name");
        return finish(ok([...databases.values()].filter((db) => name === null || db.name === name).map((db) => ({ uuid: db.id, name: db.name }))));
      }
      case "database.create": {
        const name = (await jsonBody()).name as string;
        if ([...databases.values()].some((db) => db.name === name)) return finish(bad(400, "a database with that name exists"));
        const db = seedDatabase(name, []);
        return finish(ok({ uuid: db.id, name: db.name }));
      }
      case "query": {
        const db = databases.get(decodeURIComponent(rest[2] ?? ""));
        if (!db) return finish(bad(404, "no such database"));
        const sql = String((await jsonBody()).sql);
        if (sql.startsWith("CREATE TABLE IF NOT EXISTS d1_migrations")) {
          record = { ...record, mutation: !db.tables.has("d1_migrations") };
          db.tables.add("d1_migrations");
          return finish(ok([{ success: true, results: [] }]));
        }
        if (sql.startsWith("SELECT name FROM d1_migrations")) {
          return finish(ok([{ success: true, results: db.applied.map((name) => ({ name })) }]));
        }
        if (sql.startsWith("SELECT name FROM sqlite_master")) {
          return finish(ok([{ success: true, results: [...db.tables].map((name) => ({ name })) }]));
        }
        const insert = /INSERT INTO d1_migrations \(name\) VALUES \('([^']+)'\);$/.exec(sql);
        if (!insert) return finish(bad(400, "the fake does not run that SQL"));
        record = { ...record, mutation: true, label: "query.write" };
        db.writes += 1;
        db.migrationSql.push(sql.slice(0, insert.index));
        db.applied.push(insert[1]!);
        return finish(ok([{ success: true, results: [] }]));
      }
      case "assets.session": {
        const manifest = (await jsonBody()).manifest as Record<string, { hash: string }>;
        const wanted = Object.values(manifest).map((entry) => entry.hash);
        const pending = new Set(wanted.filter((hash) => !held.has(hash)));
        if (pending.size === 0) {
          const jwt = next("done");
          completions.set(jwt, wanted);
          return finish(ok({ jwt, buckets: [] }));
        }
        const jwt = next("session");
        sessions.set(jwt, { pending, wanted });
        const hashes = [...pending];
        const buckets: string[][] = [];
        for (let i = 0; i < hashes.length; i += BUCKET) buckets.push(hashes.slice(i, i + BUCKET));
        return finish(ok({ jwt, buckets }));
      }
      case "assets.upload": {
        const session = sessions.get(bearer)!;
        if (!(body instanceof FormData)) return finish(bad(400, "expected a form"));
        for (const [hash, value] of body.entries()) {
          if (!session.pending.has(hash)) return finish(bad(400, "that file was not asked for"));
          held.set(hash, typeof value === "string" ? value : await value.text());
          session.pending.delete(hash);
        }
        if (session.pending.size > 0) return finish(ok({}, 202));
        const jwt = next("done");
        completions.set(jwt, session.wanted);
        return finish(ok({ jwt }, 201));
      }
      case "worker.get": {
        const worker = workers.get(scriptName);
        return finish(worker ? ok({ tags: worker.metadata["tags"] ?? [], bindings: worker.bindings.map(({ name, type }) => ({ name, type })) }) : bad(404, "no such script"));
      }
      case "worker.upload": {
        if (!(body instanceof FormData)) return finish(bad(400, "expected a form"));
        const metaPart = body.get("metadata");
        const metadata = JSON.parse(typeof metaPart === "string" ? metaPart : await (metaPart as Blob).text());
        const moduleName = String(metadata.main_module);
        const modulePart = body.get(moduleName);
        if (modulePart === null) return finish(bad(400, "the main module is missing"));
        const assetsJwt = metadata.assets?.jwt;
        if (assetsJwt !== undefined && !completions.has(assetsJwt)) return finish(bad(400, "the assets key is not a completed upload"));
        const before = workers.get(scriptName);
        // A new upload names its bindings; Cloudflare adds, from the running version, those of a type in keep_bindings.
        const sent = (metadata.bindings ?? []) as FakeBinding[];
        const keep = (metadata.keep_bindings ?? []) as string[];
        const kept = (before?.bindings ?? []).filter((binding) => keep.includes(binding.type) && !sent.some((own) => own.name === binding.name));
        const bindings = [...sent, ...kept].filter((binding) => !lost.has(binding.name));
        const module = typeof modulePart === "string" ? modulePart : await modulePart.text();
        workers.set(scriptName, {
          metadata,
          moduleName,
          module,
          schedules: before?.schedules ?? [],
          workersDev: before?.workersDev ?? false,
          bindings,
          versionId: before?.versionId ?? "",
        });
        const version = makeVersion(scriptName, metadata, moduleName, module, bindings, assetsJwt === undefined ? [] : (completions.get(assetsJwt) ?? []));
        deploy(scriptName, version);
        return finish(ok({ id: version.id, tags: metadata.tags ?? [] }));
      }
      case "deployment.get": {
        const list = deployments.get(scriptName);
        return finish(list ? ok({ deployments: list.map(({ id, created_on, versions: split }) => ({ id, created_on, source: "api", strategy: "percentage", versions: split })) }) : bad(404, "no such script"));
      }
      case "versions.list": {
        const list = versions.get(scriptName);
        return finish(list ? ok({ items: list.filter((version) => !version.expired).map(({ id, number }) => ({ id, number })) }) : bad(404, "no such script"));
      }
      case "deployment.create": {
        const request = await jsonBody();
        const wanted = (request?.versions ?? []) as { version_id: string; percentage: number }[];
        if (wanted.length !== 1 || wanted[0]!.percentage !== 100) return finish(bad(400, "the percentages must add to 100"));
        const target = (versions.get(scriptName) ?? []).find((version) => version.id === wanted[0]!.version_id);
        if (!target || target.expired) return finish(bad(404, "that version is not kept any more"));
        deploy(scriptName, target, route.searchParams.get("force") === "true");
        const made = deployments.get(scriptName)![0]!;
        return finish(ok({ id: made.id, created_on: made.created_on, source: "api", strategy: "percentage", versions: made.versions }));
      }
      case "bookmark.get": {
        const db = databases.get(decodeURIComponent(rest[2] ?? ""));
        return finish(db ? ok({ bookmark: bookmarkOf(db) }) : bad(404, "no such database"));
      }
      case "schedules.get": {
        const worker = workers.get(scriptName);
        return finish(worker ? ok({ schedules: worker.schedules.map((cron) => ({ cron })) }) : bad(404, "no such script"));
      }
      case "schedules.set": {
        const worker = workers.get(scriptName);
        if (!worker) return finish(bad(404, "no such script"));
        worker.schedules = ((await jsonBody()) as { cron: string }[]).map((row) => row.cron);
        return finish(ok({ schedules: worker.schedules.map((cron) => ({ cron })) }));
      }
      case "workers-dev.get": {
        const worker = workers.get(scriptName);
        return finish(worker ? ok({ enabled: worker.workersDev, previews_enabled: false }) : bad(404, "no such script"));
      }
      case "workers-dev.set": {
        const worker = workers.get(scriptName);
        if (!worker) return finish(bad(404, "no such script"));
        worker.workersDev = (await jsonBody()).enabled === true;
        return finish(ok({ enabled: worker.workersDev, previews_enabled: false }));
      }
      default:
        return finish(bad(404, "the fake does not know that path"));
    }
  }

  return {
    fetch,
    requests,
    /** One line per request; carries no key. */
    log,
    databases,
    workers,
    held,
    versions,
    deployments,
    failOnce,
    /** From now on an upload loses these bindings, kept or sent. */
    dropBindingsOnUpload: (...names: string[]): void => {
      for (const name of names) lost.add(name);
    },
    seedDatabase,
    seedWorker,
    expireVersion,
    bookmarkOf,
    /** How many calls were made, of one label or of all. Failed calls count. */
    count: (label?: string): number => requests.filter((request) => label === undefined || request.label === label).length,
    /** The asset hashes the version serving traffic holds. */
    servedAssets: (name: string): string[] => (versions.get(name) ?? []).find((version) => version.id === workers.get(name)?.versionId)?.assets ?? [],
    mutations: (): FakeRequest[] => requests.filter((request) => request.mutation),
    clearRequests: (): void => {
      requests.length = 0;
      log.length = 0;
    },
    get subdomain(): string | null {
      return subdomain;
    },
  };
}

export type FakeCloudflare = ReturnType<typeof createFakeCloudflare>;
