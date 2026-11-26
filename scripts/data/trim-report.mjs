#!/usr/bin/env node
// Trim report. Loads a D1 dump (migration level 0013) into a fresh LOCAL database, prints what the
// cut features hold, applies 0014_trim.sql locally, prints the counts again and lists every
// trim_converted row. Local only: every wrangler call passes --local and none passes --remote.
//
//   node scripts/data/trim-report.mjs <dump.sql> [name]     report on a dump
//   node scripts/data/trim-report.mjs --seed <out.sql>      write a small seeded dump at 0013
//
// Nothing here deletes a source row. The load goes through scripts/data/load-d1.sh.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const api = root;
const migrations = join(root, "migrations");
const win = process.platform === "win32";

function run(cmd, args, cwd) {
  const r = spawnSync(cmd, win ? args.map((a) => `"${a}"`) : args, { cwd, shell: win, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) {
    process.stderr.write(`${cmd} ${args.join(" ")} failed\n${(r.stderr || "").slice(-1500)}${(r.stdout || "").slice(-1500)}\n`);
    process.exit(1);
  }
  return r.stdout;
}

// Always --local. The database binding is DB, the folder is the persisted state.
const wrangler = (persist, verb, rest) =>
  run("pnpm", ["exec", "wrangler", "d1", verb, "DB", "--local", "--persist-to", persist, ...rest], api);

const execFile = (persist, file) => wrangler(persist, "execute", ["--file", file]);

const scratch = mkdtempSync(join(tmpdir(), "trim-report-"));
let n = 0;
function rows(persist, sql) {
  const file = join(scratch, `q${n++}.sql`);
  writeFileSync(file, sql);
  const out = wrangler(persist, "execute", ["--json", "--file", file]);
  return JSON.parse(out.slice(out.indexOf("[")))[0].results;
}

// D1 limits a compound SELECT to a few terms, so the counts are scalar subqueries in one row.
const KINDS = [
  ["parked tasks", "task WHERE parked_at IS NOT NULL"],
  ["task notes", "note WHERE task_id IS NOT NULL"],
  ["milestone notes", "note WHERE milestone_id IS NOT NULL"],
  ["duties", "duty"],
  ["venture links", "venture_link"],
  ["tasks with icon", "task WHERE icon IS NOT NULL"],
  ["tasks with size", "task WHERE size IS NOT NULL"],
  ["ventures with board_x or board_y", "venture WHERE board_x IS NOT NULL OR board_y IS NOT NULL"],
  ["projects with board_x or board_y", "project WHERE board_x IS NOT NULL OR board_y IS NOT NULL"],
  ["total spaces", "venture"],
  ["total projects", "project"],
  ["total milestones", "milestone"],
  ["total tasks", "task"],
  ["total notes", "note"],
  // 0014 converts only rows that are not archived. These stay in their tables, unconverted.
  ["archived task notes", "note WHERE task_id IS NOT NULL AND archived_at IS NOT NULL"],
  ["archived milestone notes", "note WHERE milestone_id IS NOT NULL AND archived_at IS NOT NULL"],
  ["archived duties", "duty WHERE archived_at IS NOT NULL"],
  // Past the limits validate.ts puts on an edit: such a row reads fine but cannot be saved unshortened.
  ["space descriptions over 500", "venture WHERE length(description) > 500"],
  ["notes over 4000", "note WHERE length(body) > 4000"],
  ["task bodies over 20000", "task WHERE length(body) > 20000"],
];
const COUNTS = `SELECT ${KINDS.map(([, from], i) => `(SELECT count(*) FROM ${from}) AS c${i}`).join(", ")}`;

function counts(persist) {
  const row = rows(persist, COUNTS)[0];
  return KINDS.map(([label], i) => ({ label, n: row[`c${i}`] }));
}

function printCounts(title, list) {
  console.log(`\n${title}`);
  const w = Math.max(...list.map((r) => r.label.length));
  for (const r of list) console.log(`  ${r.label.padEnd(w)}  ${r.n}`);
}

const Z = "'2024-01-01T00:00:00.000Z'";
// A small seed at 0013: every cut kind once or twice, plus rows that must stay as they are.
const SEED = `
INSERT INTO tenant (id, created_at) VALUES ('owner-seed', ${Z});
INSERT INTO venture (id, owner, name, description, board_x, board_y, created_at, updated_at) VALUES
  ('v1', 'owner-seed', 'One', 'About one', 10, 20, ${Z}, ${Z}),
  ('v2', 'owner-seed', 'Two', NULL, NULL, NULL, ${Z}, ${Z});
INSERT INTO venture_link (id, owner, a_id, b_id, created_at, updated_at) VALUES ('l1', 'owner-seed', 'v1', 'v2', ${Z}, ${Z});
INSERT INTO state (id, owner, venture_id, name, kind, position, created_at, updated_at) VALUES
  ('s-first', 'owner-seed', 'v1', 'To do', 'not_started', 1, ${Z}, ${Z}),
  ('s-under', 'owner-seed', 'v1', 'Doing', 'underway', 0, ${Z}, ${Z});
INSERT INTO project (id, owner, venture_id, name, board_x, board_y, created_at, updated_at) VALUES ('p1', 'owner-seed', 'v1', 'P', 5, 6, ${Z}, ${Z});
INSERT INTO milestone (id, owner, project_id, name, created_at, updated_at) VALUES
  ('m1', 'owner-seed', 'p1', 'Beta', ${Z}, ${Z}),
  ('m2', 'owner-seed', 'p1', 'Quiet', ${Z}, ${Z});
INSERT INTO task (id, owner, venture_id, title, body, state_id, parked_at, icon, size, created_at, updated_at) VALUES
  ('t-parked', 'owner-seed', 'v1', 'Parked', 'keep', 's-under', '2024-01-03T00:00:00.000Z', 'star', 'm', ${Z}, ${Z}),
  ('t-body', 'owner-seed', 'v1', 'Has notes', 'Existing body', NULL, NULL, NULL, 'l', ${Z}, ${Z}),
  ('t-free', 'owner-seed', 'v1', 'Plain', NULL, 's-under', NULL, NULL, NULL, ${Z}, ${Z});
INSERT INTO note (id, owner, task_id, body, created_at, updated_at) VALUES
  ('n-b', 'owner-seed', 't-body', 'second note', '2024-01-05T00:00:00.000Z', '2024-01-05T00:00:00.000Z'),
  ('n-a', 'owner-seed', 't-body', 'first note', '2024-01-04T00:00:00.000Z', '2024-01-04T00:00:00.000Z');
INSERT INTO note (id, owner, milestone_id, body, created_at, updated_at) VALUES
  ('m-b', 'owner-seed', 'm1', 'newer', '2024-01-06T00:00:00.000Z', '2024-01-06T00:00:00.000Z'),
  ('m-a', 'owner-seed', 'm1', 'older', '2024-01-02T00:00:00.000Z', '2024-01-02T00:00:00.000Z');
INSERT INTO note (id, owner, venture_id, body, created_at, updated_at) VALUES ('v-keep', 'owner-seed', 'v1', 'venture note stays', ${Z}, ${Z});
INSERT INTO duty (id, owner, venture_id, name, description, position, created_at, updated_at) VALUES
  ('d1', 'owner-seed', 'v1', 'Water plants', NULL, 1, ${Z}, ${Z}),
  ('d2', 'owner-seed', 'v1', 'Pay rent', 'monthly', 2, ${Z}, ${Z});
`;

// wrangler d1 export cannot read a --persist-to folder, so the seeded dump is written directly:
// migrations 0001 to 0013 in order, then the seed rows. Loading it gives a database at level 0013.
function seed(out) {
  const files = readdirSync(migrations).filter((f) => f.endsWith(".sql") && f < "0014_").sort();
  const parts = files.map((f) => `-- ${f}\n${readFileSync(join(migrations, f), "utf8")}`);
  mkdirSync(dirname(resolve(out)), { recursive: true });
  writeFileSync(resolve(out), `${parts.join("\n")}\n-- seed rows\n${SEED}`);
  console.log(`Wrote a seeded dump at migration level 0013 (${files.length} migrations) to ${resolve(out)}`);
}

function report(dump, name) {
  if (!/^[A-Za-z0-9._-]+$/.test(name) || name.startsWith(".")) {
    console.error("name must be a plain folder name");
    process.exit(2);
  }
  const persist = join(root, "data/local-load", name);
  run("bash", [join(root, "scripts/data/load-d1.sh"), resolve(dump), name], root);
  console.log(`Dump: ${basename(dump)}`);

  if (rows(persist, "SELECT name FROM sqlite_master WHERE name = 'trim_converted'").length > 0) {
    console.error("This dump already holds trim_converted, so it is past 0013. Load a dump taken before 0014.");
    process.exit(1);
  }
  printCounts("Before 0014 (migration level 0013)", counts(persist));

  execFile(persist, join(migrations, "0014_trim.sql"));
  printCounts("After 0014", counts(persist));

  const conv = rows(persist, "SELECT kind, id, target_id FROM trim_converted ORDER BY kind, id");
  console.log(`\ntrim_converted: ${conv.length} rows`);
  let last = "";
  for (const r of conv) {
    if (r.kind !== last) console.log(`  ${r.kind}`);
    last = r.kind;
    console.log(`    ${r.id} -> ${r.target_id ?? "(no target)"}`);
  }
}

try {
  const args = process.argv.slice(2);
  if (args[0] === "--seed" && args[1]) seed(args[1]);
  else if (args[0] && !args[0].startsWith("--")) report(args[0], args[1] ?? `${basename(args[0], ".sql")}-trim`);
  else {
    console.error("usage: trim-report.mjs <dump.sql> [name]   or   trim-report.mjs --seed <out.sql>");
    process.exit(2);
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
