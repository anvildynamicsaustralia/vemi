#!/usr/bin/env node
/**
 * `pnpm run dev` starts `wrangler dev` here, after the local database changes are applied.
 *
 * Where the local keys come from:
 * - From the environment, when any name the Worker reads is already set in it. That is how
 *   `infisical run -- pnpm run dev` hands over the keys: they never touch the disk.
 *   `.dev.vars` is skipped then, so an old copy of it cannot shadow the environment.
 * - From `.dev.vars` otherwise, exactly as before (shape: `.dev.vars.example`).
 *
 * Wrangler reads the environment only when told to (CLOUDFLARE_INCLUDE_PROCESS_ENV) and only
 * when it is not reading `.dev.vars`. Naming any env file with `--env-file` turns `.dev.vars`
 * off; the file named is `.dev.vars.example`, because every checkout has it and its values are
 * all empty, and a value set in the environment wins over an empty one. Wrangler then hands the
 * whole environment to the local Worker, which reads only the names it knows. This script prints
 * names only, never a value. Local only: nothing here touches a remote.
 *
 * Usage: node scripts/dev.mjs [any wrangler dev flag]
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Every name in `.dev.vars.example`, plus the two the Worker reads that the example leaves out. */
export function keyNames(exampleText) {
  const names = [...exampleText.matchAll(/^([A-Z][A-Z0-9_]*)=/gm)].map((m) => m[1] ?? "");
  return [...new Set([...names, "ORIGIN", "OPERATOR_EMAIL"])].filter((n) => n !== "");
}

/** The names from `names` that are set to something in `env`. */
export function namesInEnv(names, env) {
  return names.filter((n) => typeof env[n] === "string" && env[n] !== "");
}

/** The wrangler arguments and extra environment for one run. */
export function plan(names, env, devVarsExists, extraArgs) {
  const found = namesInEnv(names, env);
  if (found.length === 0) {
    return { source: devVarsExists ? ".dev.vars" : "none", args: ["dev", ...extraArgs], env: {} };
  }
  return {
    source: "environment",
    found,
    args: ["dev", "--env-file", ".dev.vars.example", ...extraArgs],
    env: { CLOUDFLARE_INCLUDE_PROCESS_ENV: "true" },
  };
}

function main() {
  const example = readFileSync(join(ROOT, ".dev.vars.example"), "utf8");
  const run = plan(keyNames(example), process.env, existsSync(join(ROOT, ".dev.vars")), process.argv.slice(2));
  if (run.source === "environment") {
    console.log(`dev: keys from the environment (${run.found.join(", ")}); .dev.vars is not read.`);
  } else if (run.source === ".dev.vars") {
    console.log("dev: keys from .dev.vars.");
  } else {
    console.log("dev: no local keys. Passwords only. See CONTRIBUTING.md, \"Run it on your machine\".");
  }
  const wrangler = join(dirname(createRequire(import.meta.url).resolve("wrangler/package.json")), "bin", "wrangler.js");
  const child = spawn(process.execPath, [wrangler, ...run.args], {
    cwd: ROOT,
    stdio: "inherit",
    env: { ...process.env, ...run.env },
  });
  child.on("exit", (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    else process.exit(code ?? 1);
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
