#!/usr/bin/env node
/**
 * Seeds staging from a fresh production dump, and proves the dump restores along the
 * way. This is the off-Cloudflare copy: `wrangler d1 export` reads production straight
 * from Cloudflare and writes it to `data/backups/`, a plain file that outlives the
 * account. The same file is then restored into a throwaway local D1 (the restore proof)
 * before it ever touches staging, and only once that matches does staging get emptied
 * and reloaded.
 *
 * Every wrangler call runs through `execFileSync` with `shell: false`, the way
 * `src/api/worker.test.ts` invokes it, and stops at the first failure with its
 * output. The script reads production and never writes to it: every remote call against
 * `vemi` (through the merged production config) is either `export` or a read-only `SELECT`; every write goes to
 * `vemi-staging` through the merged staging config.
 *
 * Only Andy runs this by hand. Forge never touches a remote database.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { writeAndyConfig } from "./andy-config.mjs";
import { compareCounts, countQuery, countsFromRows, dropEverything, inRestoreOrder, LEFT_OUT_OF_STAGING, TABLE_LIST_SQL, withoutTables } from "./stagingSql.mjs";

const SCRIPTS_DIR = dirname(fileURLToPath(import.meta.url));
/** The repo root: wrangler.jsonc, migrations/ and node_modules live here. */
const API_ROOT = join(SCRIPTS_DIR, "..");
const REPO_ROOT = API_ROOT;
const WRANGLER = join(API_ROOT, "node_modules", "wrangler", "bin", "wrangler.js");
const BACKUPS_DIR = join(REPO_ROOT, "data", "backups");

const USAGE = `Usage: node scripts/seed-staging.mjs

Exports production's D1 ("vemi") to data/backups/, restores that file into a throwaway
local D1 to prove the backup restores, then empties staging and loads the same file into
it, without the passkey tables, and compares row counts there too.

Reads production and never writes to it. Run from anywhere; wrangler is always invoked
with the repo root as its working directory, where wrangler.jsonc lives.`;

function utcStamp(now = new Date()) {
  return now.toISOString().replace(/[:.]/g, "-");
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

/** The `results` array of a `wrangler d1 execute --json` call's first statement. */
function rowsOf(jsonOutput) {
  const parsed = JSON.parse(jsonOutput);
  const first = Array.isArray(parsed) ? parsed[0] : parsed;
  return first?.results ?? [];
}

function tableNamesFrom(jsonOutput) {
  return rowsOf(jsonOutput).map((row) => String(row.name));
}

function countsFrom(jsonOutput) {
  return countsFromRows(rowsOf(jsonOutput));
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    console.log(USAGE);
    return;
  }

  // Andy's two environments, merged from andy.local.json. Local D1 calls need neither.
  const PRODUCTION_CONFIG = writeAndyConfig("production", "wrangler.andy.production.jsonc");
  const STAGING_CONFIG = writeAndyConfig("staging", "wrangler.andy.staging.jsonc");

  mkdirSync(BACKUPS_DIR, { recursive: true });
  const file = join(BACKUPS_DIR, `production-${utcStamp()}.sql`);

  console.log(`exporting production to ${file}`);
  wrangler(["d1", "export", "vemi", "--remote", "--config", PRODUCTION_CONFIG, "--output", file]);

  const tableNames = tableNamesFrom(wrangler(["d1", "execute", "vemi", "--remote", "--config", PRODUCTION_CONFIG, "--json", "--command", TABLE_LIST_SQL]));
  const prodCounts = countsFrom(wrangler(["d1", "execute", "vemi", "--remote", "--config", PRODUCTION_CONFIG, "--json", "--command", countQuery(tableNames)]));

  const localPersist = mkdtempSync(join(tmpdir(), "vemi-seed-local-"));
  // The export keeps creation order; the restore needs each table before what references it.
  const dump = inRestoreOrder(readFileSync(file, "utf8"));
  const restoreFile = join(localPersist, "restore.sql");
  writeFileSync(restoreFile, dump);
  wrangler(["d1", "execute", "vemi", "--local", "--persist-to", localPersist, "--file", restoreFile]);
  const localCounts = countsFrom(
    wrangler(["d1", "execute", "vemi", "--local", "--persist-to", localPersist, "--json", "--command", countQuery(tableNames)]),
  );

  const restoreMismatches = compareCounts(prodCounts, localCounts, []);
  if (restoreMismatches.length > 0) {
    console.error("the backup did not restore");
    for (const line of restoreMismatches) console.error(`  ${line}`);
    process.exit(1);
  }

  // dropEverything appends d1_migrations itself, so it is left out of the names passed in.
  // "vemi-staging" is the database name, not the binding: tests/d1-one-file.test.ts bans
  // the binding name outside store.ts, and every wrangler call here is a CLI argument, not
  // a reference to the binding.
  const schemaTables = tableNames.filter((name) => name !== "d1_migrations");
  wrangler(["d1", "execute", "vemi-staging", "--remote", "--config", STAGING_CONFIG, "--command", dropEverything(schemaTables)]);

  const stagingFile = join(localPersist, "staging-seed.sql");
  writeFileSync(stagingFile, withoutTables(dump, LEFT_OUT_OF_STAGING));
  wrangler(["d1", "execute", "vemi-staging", "--remote", "--config", STAGING_CONFIG, "--file", stagingFile]);

  const stagingCounts = countsFrom(
    wrangler(["d1", "execute", "vemi-staging", "--remote", "--config", STAGING_CONFIG, "--json", "--command", countQuery(tableNames)]),
  );
  const stagingMismatches = compareCounts(prodCounts, stagingCounts, LEFT_OUT_OF_STAGING);
  if (stagingMismatches.length > 0) {
    console.error("counts do not match on staging");
    for (const line of stagingMismatches) console.error(`  ${line}`);
    process.exit(1);
  }

  rmSync(localPersist, { recursive: true, force: true });

  const size = statSync(file).size;
  console.log(`${file} (${size} bytes)`);
  console.log("restored locally and on staging, counts match");
}

main();
