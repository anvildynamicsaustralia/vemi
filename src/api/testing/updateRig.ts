/**
 * Test support for the update steps: a release signed in memory, served by a fake feed, beside the
 * fake Cloudflare, with the copy's sealed key kept in a real test database. Counts every request a
 * single tap makes, so a test can hold a step to the subrequest limit.
 */
import { CLOUDFLARE_BASE } from "../../shared/setup/cloudflareApi.js";
import { createFakeCloudflare, type FakeCloudflare } from "../../shared/setup/fakeCloudflare.js";
import { buildManifest, type ReleaseFile, type ReleaseManifest } from "../../shared/setup/releaseManifest.js";
import { createSelfUpdate, type SelfUpdate } from "../selfUpdate.js";
import { sealToken } from "../setup.js";
import { openStore, type Store } from "../store.js";
import type { TestDb } from "./d1.js";

export const FEED = "https://feed.example.org/release/";
export const ORIGIN = "https://vemi.example.workers.dev";
export const CODE = "a-setup-code-only-the-page-knows";
export const TOKEN = "cf-token-value-for-tests-0123456789";
export const T0 = new Date("2026-12-01T11:00:00.000Z");

const enc = (text: string): Uint8Array => new TextEncoder().encode(text);
export const b64url = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

export interface Keys {
  publicKey: string;
  privateKey: CryptoKey;
}

export async function makeKeys(): Promise<Keys> {
  const pair = (await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"])) as CryptoKeyPair;
  return { publicKey: b64url(new Uint8Array((await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer)), privateKey: pair.privateKey };
}

export interface Release {
  version: string;
  manifest: ReleaseManifest;
  manifestText: string;
  signature: string;
  /** Every file the feed serves, by path under `<feed><version>/`. */
  files: Map<string, Uint8Array>;
  worker: ReleaseFile;
  client: ReleaseFile[];
  migrations: ReleaseFile[];
}

const file = (path: string, text: string): ReleaseFile => ({ path, bytes: enc(text) });

/** A release signed with `keys`. The files are small, and five client files make three buckets in the fake. */
export async function makeRelease(keys: Keys, version = "0.2.0", notes = "A calmer Today.", extraClient = 0): Promise<Release> {
  const worker = file("worker/index.js", `export default { fetch() { return new Response('${version}'); } };`);
  const client = [
    file("/index.html", `<html>${version}</html>`),
    file("/assets/app.js", `console.log("${version}")`),
    file("/assets/app.css", "body{}"),
    file("/manifest.webmanifest", "{}"),
    file("/icons/a.png", "png-bytes"),
    ...Array.from({ length: extraClient }, (_, n) => file(`/assets/extra-${n}.js`, `export const n = ${n};`)),
  ];
  const migrations = [file("0034_more.sql", "CREATE TABLE more (x TEXT);"), file("0035_again.sql", "CREATE TABLE again (x TEXT);\n-- end")];
  const manifest = await buildManifest({
    version, issuedAt: "2026-11-25T00:00:00.000Z", notesFile: `# Notes\n\n## ${version}\n\n${notes}\n`, compatibilityDate: "2026-09-11", bindings: [], variables: [], worker, client, migrations,
  });
  const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
  const signature = b64url(new Uint8Array(await crypto.subtle.sign("Ed25519", keys.privateKey, enc(manifestText) as BufferSource)));
  const files = new Map<string, Uint8Array>();
  files.set(worker.path, worker.bytes);
  for (const f of client) files.set(`client/${f.path.slice(1)}`, f.bytes);
  for (const f of migrations) files.set(`migrations/${f.path}`, f.bytes);
  return { version, manifest, manifestText, signature, files, worker, client, migrations };
}

export interface Rig {
  fake: FakeCloudflare;
  store: Store;
  update: SelfUpdate;
  release: Release;
  keys: Keys;
  /** Requests made since the last `tap()`: feed reads and Cloudflare calls. */
  taps: () => number;
  /** Counts a tap's requests from now. */
  tap: () => void;
  /** Feed paths served, in order. */
  feedLog: string[];
  /** Makes the next feed read of this path answer these bytes. */
  tamper: (path: string, bytes: Uint8Array) => void;
  /** Fails the next migration write once with a 500. */
  failNextMigration: () => void;
}

export interface RigOptions {
  release?: Release;
  keys?: Keys;
  origin?: string;
  /** Keep a sealed key; default true. */
  keepKey?: boolean;
  /** Keep the signed offer in the store; default true. */
  offer?: boolean;
  /** The version running now. */
  running?: string;
  now?: () => Date;
}

/** A copy named `vemi` at version 0.1.0 with its database, secret, cron and address, an offer for the release, and the steps over them. */
export async function makeRig(t: TestDb, options: RigOptions = {}): Promise<Rig> {
  const keys = options.keys ?? (await makeKeys());
  const release = options.release ?? (await makeRelease(keys));
  const origin = options.origin ?? ORIGIN;
  const now = options.now ?? ((): Date => T0);
  const store = openStore({ DB: t.db }, now);
  const fake = createFakeCloudflare({ token: TOKEN, subdomain: "example" });
  const db = fake.seedDatabase("vemi", ["d1_migrations"]);
  db.applied.push("0001_old.sql");
  fake.seedWorker("vemi", ["vemi:0.1.0"], [
    { name: "DB", type: "d1", id: db.id },
    { name: "LIVE", type: "durable_object_namespace", class_name: "Live" },
    { name: "ASSETS", type: "assets" },
    { name: "OWNER", type: "plain_text", text: "owner" },
    { name: "TIME_ZONE", type: "plain_text", text: "UTC" },
    { name: "SETUP_FROM", type: "plain_text", text: "https://helper.example.test" },
    { name: "SETUP_CLAIM", type: "secret_text" },
    { name: "VAPID_PRIVATE", type: "secret_text" },
  ]);
  const worker = fake.workers.get("vemi")!;
  worker.schedules = ["* * * * *"];
  worker.workersDev = true;
  fake.clearRequests();

  if (options.keepKey !== false) await store.keepSetupClaim(await sealToken(TOKEN, CODE, origin), true);
  else await store.keepSetupClaim(null, false);
  // A database shared between rigs starts each from no open run and no offer.
  await store.keepUpdateRun({
    version: "0.0.0", step: "done", state: "done", accountId: null, databaseId: null, workerName: null, previousVersionId: null, previousVersion: null,
    newVersionId: null, bookmark: null, migrated: 0, startedAt: now().toISOString(), backUntil: null,
  });
  await store.keepUpdateCheck(null);
  if (options.offer !== false) await store.keepUpdateCheck({ version: release.version, manifest: release.manifestText, signature: release.signature });

  const feedLog: string[] = [];
  const swapped = new Map<string, Uint8Array>();
  let counted = 0;
  let failMigration = false;
  const fetch = async (url: string, init?: RequestInit): Promise<Response> => {
    counted += 1;
    if (url.startsWith(CLOUDFLARE_BASE)) {
      if (failMigration && url.endsWith("/query") && typeof init?.body === "string" && init.body.includes("INSERT INTO d1_migrations")) {
        failMigration = false;
        return new Response(JSON.stringify({ success: false, errors: [{ message: "internal error" }], result: null }), { status: 500 });
      }
      return fake.fetch(url, init);
    }
    if (url.startsWith(`${FEED}${release.version}/`)) {
      const path = url.slice(`${FEED}${release.version}/`.length);
      feedLog.push(path);
      const bytes = swapped.get(path) ?? release.files.get(path);
      return bytes === undefined ? new Response("missing", { status: 404 }) : new Response(bytes as BodyInit);
    }
    return new Response("missing", { status: 404 });
  };

  const update = createSelfUpdate({
    store, secret: CODE, origin, feed: FEED, publicKey: keys.publicKey, version: options.running ?? "0.1.0", fetch, now,
  });
  return {
    fake, store, update, release, keys, feedLog,
    taps: () => counted,
    tap: () => {
      counted = 0;
    },
    tamper: (path, bytes) => {
      swapped.set(path, bytes);
    },
    failNextMigration: () => {
      failMigration = true;
    },
  };
}
