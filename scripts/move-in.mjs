#!/usr/bin/env node
/**
 * Moves a production dump into the new, empty database on the new account. The dump is
 * the plain file `wrangler d1 export` wrote; it is restored into a
 * throwaway local D1 first, so the expected row counts come from the file itself, and
 * only then loaded into the target, whose counts are compared against those.
 *
 * Every wrangler call runs through `execFileSync` with `shell: false`, with the repo root as
 * its working directory so the pinned wrangler.jsonc decides the account. This script
 * never sets CLOUDFLARE_ACCOUNT_ID. Every remote call carries the merged config (`wrangler.andy.*.jsonc`), which pins it
 * and the target is `vemi-staging`, loaded without the passkey tables' rows.
 *
 * It writes only to an empty database: a target that already holds any table is refused
 * before anything is written. It never drops, deletes or updates anything.
 *
 * Only Andy or the orchestrator runs this, by hand, once per database. Forge never
 * touches a remote database.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { writeAndyConfig } from "./andy-config.mjs";
import {
  compareCounts,
  countQuery,
  countsFromRows,
  inRestoreOrder,
  LEFT_OUT_OF_STAGING,
  moveInSql,
  notEmptyRefusal,
  TABLE_LIST_SQL,
  tablesInDump,
} from "./stagingSql.mjs";

const SCRIPTS_DIR = dirname(fileURLToPath(import.meta.url));
/** The repo root: wrangler.jsonc, migrations/ and node_modules live here. */
const API_ROOT = join(SCRIPTS_DIR, "..");
const WRANGLER = join(API_ROOT, "node_modules", "wrangler", "bin", "wrangler.js");

const USAGE = `Usage: node scripts/move-in.mjs --file <dump.sql> [--env staging]

Loads a production dump into the new, empty database: "vemi", or "vemi-staging" with
--env staging (staging is loaded without the passkey tables' rows).

The dump is restored into a throwaway local D1 first to learn the expected row counts.
A target that already holds any table is refused before anything is written. After the
load the target's row counts are compared with the expected ones.

Refuses, before any remote call, without --file, or when the file does not exist or lacks
the d1_migrations and tenant tables. Run from anywhere; wrangler is always invoked with
the repo root as its working directory, where wrangler.jsonc lives.`;

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

function refuse(message) {
  console.error(message);
  process.exit(1);
}

/** The value after `flag`, or `undefined` when the flag is absent or last. */
function valueOf(args, flag) {
  const at = args.indexOf(flag);
  const value = at === -1 ? undefined : args[at + 1];
  // A flag in the value's place means the value was left out.
  return value === undefined || value.startsWith("--") ? undefined : value;
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    console.log(USAGE);
    return;
  }

  const fileArg = valueOf(args, "--file");
  if (!fileArg) refuse(`--file <dump.sql> is required\n\n${USAGE}`);
  const envArg = valueOf(args, "--env");
  if (args.includes("--env") && envArg !== "staging") refuse(`--env takes only "staging"\n\n${USAGE}`);
  const staging = envArg === "staging";
  const database = staging ? "vemi-staging" : "vemi";
  // The target is one of Andy's two environments, merged from andy.local.json.
  const envFlags = ["--config", writeAndyConfig(staging ? "staging" : "production", staging ? "wrangler.andy.staging.jsonc" : "wrangler.andy.production.jsonc")];

  const file = resolve(fileArg);
  if (!existsSync(file)) refuse(`${file} does not exist`);
  const dump = readFileSync(file, "utf8");
  const inDump = tablesInDump(dump);
  for (const required of ["d1_migrations", "tenant"]) {
    if (!inDump.includes(required)) refuse(`${file} has no ${required} table: it is not a production dump`);
  }

  const work = mkdtempSync(join(tmpdir(), "vemi-move-in-"));
  // It holds a full copy of production, so it goes on every way out, refusals included.
  process.on("exit", () => rmSync(work, { recursive: true, force: true }));

  // The expected counts: the dump restored into a throwaway local D1.
  const localPersist = join(work, "local");
  const restoreFile = join(work, "restore.sql");
  writeFileSync(restoreFile, inRestoreOrder(dump));
  wrangler(["d1", "execute", "vemi", "--local", "--persist-to", localPersist, "--file", restoreFile]);
  const tableNames = tableNamesFrom(
    wrangler(["d1", "execute", "vemi", "--local", "--persist-to", localPersist, "--json", "--command", TABLE_LIST_SQL]),
  );
  const expected = countsFrom(
    wrangler(["d1", "execute", "vemi", "--local", "--persist-to", localPersist, "--json", "--command", countQuery(tableNames)]),
  );

  // Nothing is written until the target is known to be empty.
  const targetTables = tableNamesFrom(
    wrangler(["d1", "execute", database, ...envFlags, "--remote", "--json", "--command", TABLE_LIST_SQL]),
  );
  const refusal = notEmptyRefusal(database, targetTables);
  if (refusal !== null) refuse(refusal);

  const loadFile = join(work, "move-in.sql");
  writeFileSync(loadFile, moveInSql(dump, staging));
  wrangler(["d1", "execute", database, ...envFlags, "--remote", "--file", loadFile]);

  const actual = countsFrom(
    wrangler(["d1", "execute", database, ...envFlags, "--remote", "--json", "--command", countQuery(tableNames)]),
  );
  const mismatches = compareCounts(expected, actual, staging ? LEFT_OUT_OF_STAGING : []);
  if (mismatches.length > 0) {
    console.error(`counts do not match on ${database}`);
    for (const line of mismatches) console.error(`  ${line}`);
    process.exit(1);
  }

  console.log(`${file} (${statSync(file).size} bytes)`);
  console.log(`${database}: moved in, counts match`);
}

main();
