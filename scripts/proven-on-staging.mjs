#!/usr/bin/env node
/**
 * The staging-first gate: refuses to let `pnpm run deploy:production` continue while any migration in
 * `migrations/` has not yet been applied on staging. Run before `wrangler d1 migrations
 * apply` and `wrangler deploy` in the `deploy:production` script of `package.json`; `deploy:staging`
 * carries no such check.
 *
 * Reads staging only: `wrangler d1 migrations list` reports what is pending there, and
 * nothing here writes to staging or production. The database it asks about is named by
 * `vemi-staging`, the same identifier `seed-staging.mjs` uses for every remote call
 * against it, so the D1 binding stays named in the one file allowed to name it
 * (`src/api/store.ts`).
 *
 * Every wrangler call runs through `execFileSync` with `shell: false`, the way
 * `src/api/worker.test.ts` and `seed-staging.mjs` invoke it.
 *
 * Only Andy runs `pnpm run deploy:production`. It reads staging through the git-ignored `wrangler.andy.staging.jsonc` that `andy-config.mjs` builds. Forge never touches a remote database.
 */
import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { writeAndyConfig } from "./andy-config.mjs";
import { parseMigrationsList, pendingMigrations, stagingGateMessage } from "./stagingSql.mjs";

const SCRIPTS_DIR = dirname(fileURLToPath(import.meta.url));
/** The repo root: wrangler.jsonc, migrations/ and node_modules live here. */
const API_ROOT = join(SCRIPTS_DIR, "..");
const WRANGLER = join(API_ROOT, "node_modules", "wrangler", "bin", "wrangler.js");
const MIGRATIONS_DIR = join(API_ROOT, "migrations");
const STAGING_DATABASE = "vemi-staging";

const USAGE = `Usage: node scripts/proven-on-staging.mjs

Fails with exit 1 and lists every migration in migrations/ that has not yet been applied
on staging. Run from anywhere; wrangler is always invoked with the repo root as its working
directory, where wrangler.jsonc lives. Reads staging and writes nothing anywhere.`;

/** Every migration file in `migrations/`, in the order `wrangler d1 migrations apply`
 *  applies them: `readdirSync(...).sort()`, matching `testing/d1.ts`'s
 *  `migrationStatements()`. */
function localMigrationFiles() {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();
}

/** Runs wrangler as a child process, never through a shell, and stops the script at the
 *  first failure with whatever wrangler printed. */
function wrangler(args) {
  try {
    return execFileSync(process.execPath, [WRANGLER, ...args], {
      cwd: API_ROOT,
      encoding: "utf8",
      stdio: "pipe",
      env: { ...process.env, CI: "1", WRANGLER_SEND_METRICS: "false", NO_COLOR: "1" },
    });
  } catch (err) {
    const detail = [err.stdout, err.stderr].filter(Boolean).join("\n") || err.message;
    console.error(`wrangler ${args.join(" ")} failed:\n${detail}`);
    process.exit(1);
  }
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    console.log(USAGE);
    return;
  }

  const localFiles = localMigrationFiles();
  const stagingConfig = writeAndyConfig("staging", "wrangler.andy.staging.jsonc");
  const stdout = wrangler(["d1", "migrations", "list", STAGING_DATABASE, "--remote", "--config", stagingConfig]);
  const notYetOnStaging = new Set(parseMigrationsList(stdout));
  const appliedOnStaging = localFiles.filter((name) => !notYetOnStaging.has(name));
  const pending = pendingMigrations(localFiles, appliedOnStaging);

  if (pending.length > 0) {
    console.error(stagingGateMessage(pending));
    process.exit(1);
  }

  console.log("every local migration is applied on staging");
}

main();
