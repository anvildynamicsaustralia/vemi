#!/usr/bin/env node
// The entry bundle budget. Reads dist/web/index.html, takes every script, modulepreload and
// stylesheet it references, gzips each file at level 9, sums them and compares the sum with
// scripts/bundle-budget.json. More than 5% over the recorded figure fails. It never passes by
// finding nothing: no page, no script, a missing file or a missing figure all fail.
//
//   node scripts/bundle-budget.mjs                      check
//   node scripts/bundle-budget.mjs --record "<reason>"  write the figure
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

/** The room above the recorded figure, in percent. */
export const ALLOWED_PERCENT = 5;

/**
 * The files index.html loads on a first visit, as references under dist/web.
 * @param {string} html
 * @returns {{scripts: string[], others: string[]}}
 */
export function referencedFiles(html) {
  const scripts = [];
  const others = [];
  for (const tag of html.match(/<(?:script|link)\b[^>]*>/gi) ?? []) {
    const attr = (name) =>
      new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, "i").exec(tag)?.slice(1).find((v) => v !== undefined);
    if (/^<script/i.test(tag)) {
      const src = attr("src");
      if (src) scripts.push(src);
    } else {
      const rel = (attr("rel") ?? "").toLowerCase().split(/\s+/);
      const href = attr("href");
      if (href && (rel.includes("modulepreload") || rel.includes("stylesheet"))) others.push(href);
    }
  }
  return { scripts, others };
}

/**
 * Measure the entry. Throws a plain sentence when it cannot.
 * @param {string} root
 * @returns {{files: {name: string, bytes: number}[], total: number}}
 */
export function measure(root) {
  const web = join(root, "dist", "web");
  const page = join(web, "index.html");
  if (!existsSync(page)) throw new Error("dist/web/index.html is missing, so there is nothing to measure. Run the build first.");
  const { scripts, others } = referencedFiles(readFileSync(page, "utf8"));
  if (scripts.length === 0) throw new Error("dist/web/index.html references no script, so there is nothing to measure.");
  const files = [];
  for (const ref of new Set([...scripts, ...others])) {
    const path = join(web, (ref.split(/[?#]/)[0] ?? "").replace(/^\/+/, ""));
    if (!existsSync(path)) throw new Error(`dist/web/index.html references ${ref}, which is not in dist/web.`);
    files.push({ name: ref, bytes: gzipSync(readFileSync(path), { level: 9 }).length });
  }
  return { files, total: files.reduce((sum, file) => sum + file.bytes, 0) };
}

function readFigure(root) {
  const path = join(root, "scripts", "bundle-budget.json");
  if (!existsSync(path)) throw new Error('scripts/bundle-budget.json is missing. Record a figure with --record "<reason>".');
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error("scripts/bundle-budget.json does not parse.");
  }
  if (!parsed || !Number.isInteger(parsed.gzipBytes) || parsed.gzipBytes <= 0) {
    throw new Error("scripts/bundle-budget.json holds no usable gzipBytes.");
  }
  return parsed;
}

/**
 * Run the check or the record. Returns the exit code and the text to print.
 * @param {{root: string, args: string[], today?: string}} options
 * @returns {{code: number, text: string}}
 */
export function runBudget({ root, args, today = new Date().toISOString().slice(0, 10) }) {
  try {
    const at = args.indexOf("--record");
    const measured = measure(root);
    const detail = measured.files.map((file) => `  ${file.bytes} ${file.name}`).join("\n");
    const over = (recorded) => measured.total * 100 > recorded * (100 + ALLOWED_PERCENT);
    if (at >= 0) {
      const reason = (args[at + 1] ?? "").trim();
      if (reason === "") throw new Error("--record needs a reason, and it was empty.");
      const path = join(root, "scripts", "bundle-budget.json");
      if (existsSync(path)) {
        const old = readFigure(root);
        if (over(old.gzipBytes) && reason === old.reason) {
          throw new Error(
            `The entry is ${measured.total} bytes, more than ${ALLOWED_PERCENT}% over the recorded ${old.gzipBytes}. Raising the figure that far needs a new reason, not the recorded one.`,
          );
        }
      }
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, `${JSON.stringify({ gzipBytes: measured.total, recordedOn: today, reason }, null, 2)}\n`);
      return { code: 0, text: `Recorded ${measured.total} bytes gzip (${reason}).\n${detail}` };
    }
    const recorded = readFigure(root).gzipBytes;
    const percent = ((measured.total - recorded) / recorded) * 100;
    if (over(recorded)) {
      return {
        code: 1,
        text: `Bundle budget exceeded: the entry is ${measured.total} bytes gzip against a recorded ${recorded}, ${percent.toFixed(1)}% over (limit ${ALLOWED_PERCENT}%).\n${detail}`,
      };
    }
    const where = measured.total < recorded ? `${Math.abs(percent).toFixed(1)}% under` : `${percent.toFixed(1)}% over, within ${ALLOWED_PERCENT}%`;
    return { code: 0, text: `Bundle budget ok: the entry is ${measured.total} bytes gzip against a recorded ${recorded}, ${where}.\n${detail}` };
  } catch (error) {
    return { code: 1, text: `Bundle budget: ${error instanceof Error ? error.message : String(error)}` };
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const result = runBudget({ root, args: process.argv.slice(2) });
  console[result.code === 0 ? "log" : "error"](result.text);
  process.exit(result.code);
}
