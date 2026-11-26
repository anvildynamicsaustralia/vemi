#!/usr/bin/env node
/**
 * Andy's environments, kept out of the committed config. The committed `wrangler.jsonc` is a
 * stranger's copy: no account, no domain, no database ID. Andy's real values live in the
 * git-ignored `andy.local.json` (shape: `scripts/andy.local.example.json`), and this script merges
 * the two into a git-ignored `wrangler.andy.jsonc` that `wrangler ... --config` reads.
 *
 * An override file, not a committed `env.staging`: a committed section would hand real IDs to a
 * public repo, and wrangler does not inherit bindings, `vars`, the Durable Object or the cron into
 * an environment, so each merged config restates them whole.
 *
 * Usage: node scripts/andy-config.mjs <production|staging|front> [--out <file>]
 *
 * Reads two local files and writes one. It never calls Cloudflare.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** The repo root: wrangler.jsonc, andy.local.json and the merged file live here. */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** The merged file the deploy scripts read. */
export const DEPLOY_CONFIG = "wrangler.andy.jsonc";

const ENVIRONMENTS = {
  production: { name: "vemi", database: "vemi" },
  staging: { name: "vemi-staging", database: "vemi-staging" },
};

/** Removes `//` line comments and block comments outside strings, as wrangler's JSONC allows. */
export function stripJsonc(text) {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j + 1;
    } else if (ch === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
    } else if (ch === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end === -1 ? text.length : end + 2;
    } else {
      out += ch;
      i++;
    }
  }
  return out.replace(/,(\s*[}\]])/g, "$1");
}

function need(value, label) {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`andy.local.json: ${label} is missing`);
  return value;
}

/**
 * The committed config `base` plus Andy's `local` values, as one flat config for `env`
 * (`production` or `staging`). Neither input is changed.
 */
export function merge(base, local, env) {
  const spec = ENVIRONMENTS[env];
  if (!spec) throw new Error(`environment must be production or staging, got "${env}"`);
  const accountId = need(local?.account_id, "account_id");
  const owner = need(local?.owner, "owner");
  const mine = local?.[env];
  const databaseId = need(mine?.database_id, `${env}.database_id`);
  const domain = need(mine?.domain, `${env}.domain`);
  const origin = need(mine?.origin, `${env}.origin`);
  if (origin !== `https://${domain}`) throw new Error(`andy.local.json: ${env}.origin must be https://${domain}`);

  const copy = structuredClone(base);
  const database = copy.d1_databases?.[0];
  if (!database) throw new Error("wrangler.jsonc has no D1 database to merge into");
  return {
    ...copy,
    name: spec.name,
    account_id: accountId,
    workers_dev: false,
    routes: [{ pattern: domain, custom_domain: true }],
    d1_databases: [{ ...database, database_name: spec.database, database_id: databaseId }],
    // Restated whole, as wrangler does not carry these into an environment.
    durable_objects: copy.durable_objects,
    migrations: copy.migrations,
    triggers: copy.triggers,
    vars: { ...copy.vars, OWNER: owner, ORIGIN: origin },
  };
}

/**
 * The front door's committed config `base` (wrangler.front.jsonc) plus Andy's `local` values: his
 * account, the KV namespace that holds the relay's day counter, and the domain the front answers on.
 * It has no D1 to merge. Neither input is changed.
 */
export function mergeFront(base, local) {
  const accountId = need(local?.account_id, "account_id");
  const mine = local?.front;
  const namespaceId = need(mine?.kv_namespace_id, "front.kv_namespace_id");
  const domain = need(mine?.domain, "front.domain");
  const copy = structuredClone(base);
  const kv = copy.kv_namespaces?.find((k) => k.binding === "RELAY_DAY");
  if (!kv) throw new Error("wrangler.front.jsonc has no RELAY_DAY namespace to merge into");
  return {
    ...copy,
    account_id: accountId,
    workers_dev: false,
    routes: [{ pattern: domain, custom_domain: true }],
    kv_namespaces: [{ ...kv, id: namespaceId }],
  };
}

/** Throws unless the front's part of `local` holds real values. */
export function assertRealFront(local) {
  if (!/^[0-9a-f]{32}$/.test(local?.account_id ?? "")) throw new Error("andy.local.json: account_id must be 32 hex characters");
  if (!/^[0-9a-f]{32}$/.test(local.front?.kv_namespace_id ?? "")) throw new Error("andy.local.json: front.kv_namespace_id must be 32 hex characters");
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(local.front?.domain ?? "")) throw new Error("andy.local.json: front.domain must be a domain name");
}

/** Throws unless `local` holds real values: not the example's words. */
export function assertReal(local) {
  if (!/^[0-9a-f]{32}$/.test(local?.account_id ?? "")) throw new Error("andy.local.json: account_id must be 32 hex characters");
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  for (const env of Object.keys(ENVIRONMENTS)) {
    const id = local[env]?.database_id ?? "";
    if (!uuid.test(id)) throw new Error(`andy.local.json: ${env}.database_id must be a UUID`);
  }
  if (local.production.database_id === local.staging.database_id) throw new Error("andy.local.json: production and staging need different databases");
  if (local.production.domain === local.staging.domain) throw new Error("andy.local.json: production and staging need different domains");
}

/** Reads the committed config and `andy.local.json`, checks them, and writes the merge to `file`. */
export function writeAndyConfig(env, file = DEPLOY_CONFIG) {
  const localPath = join(ROOT, "andy.local.json");
  if (!existsSync(localPath)) {
    throw new Error("andy.local.json is missing: copy scripts/andy.local.example.json to andy.local.json and fill it (see .works/efforts/VEMI-013_release/DEPLOY.md)");
  }
  const local = JSON.parse(readFileSync(localPath, "utf8"));
  let merged;
  if (env === "front") {
    const base = JSON.parse(stripJsonc(readFileSync(join(ROOT, "wrangler.front.jsonc"), "utf8")));
    assertRealFront(local);
    merged = mergeFront(base, local);
  } else {
    const base = JSON.parse(stripJsonc(readFileSync(join(ROOT, "wrangler.jsonc"), "utf8")));
    assertReal(local);
    merged = merge(base, local, env);
  }
  writeFileSync(join(ROOT, file), JSON.stringify(merged, null, 2) + "\n");
  return file;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2);
  const out = args.includes("--out") ? args[args.indexOf("--out") + 1] : undefined;
  try {
    const file = writeAndyConfig(args[0] ?? "", out ?? DEPLOY_CONFIG);
    console.log(`wrote ${file} for ${args[0]}`);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
