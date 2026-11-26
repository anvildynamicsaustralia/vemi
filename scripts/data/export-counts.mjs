// Prints the count of every kind (table) in a VEMI export, one line each, so Andy can
// compare it with the `counts` a restore answers and with a second export.
// Usage: node scripts/data/export-counts.mjs <export.json> [other-export.json]
// With a second file it prints both and exits 1 unless every line is equal. It reads only
// the files it is handed and never calls any service.
import { readFileSync } from "node:fs";

/** @param {unknown} doc @returns {Record<string, number>} */
export function countsOf(doc) {
  const tables = /** @type {any} */ (doc)?.tables;
  if (!tables || typeof tables !== "object" || Array.isArray(tables)) {
    throw new Error("This is not a VEMI export: it has no tables.");
  }
  /** @type {Record<string, number>} */
  const out = {};
  for (const name of Object.keys(tables).sort()) {
    const rows = tables[name];
    if (!Array.isArray(rows)) throw new Error(`Table ${name} is not a list of rows.`);
    out[name] = rows.length;
  }
  return out;
}

/** @param {Record<string, number>} counts */
export function lines(counts) {
  return Object.entries(counts).map(([k, n]) => `${k}: ${n}`);
}

/** Lines that differ between two counts, empty when equal. @param {Record<string, number>} a @param {Record<string, number>} b */
export function differences(a, b) {
  const out = [];
  for (const k of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) {
    if (a[k] !== b[k]) out.push(`${k}: ${a[k] ?? "missing"} against ${b[k] ?? "missing"}`);
  }
  return out;
}

const self = process.argv[1] ? process.argv[1].replace(/\\/g, "/").split("/").pop() : "";
if (self === "export-counts.mjs") {
  const [first, second] = process.argv.slice(2);
  if (!first) {
    console.error("usage: node scripts/data/export-counts.mjs <export.json> [other-export.json]");
    process.exit(2);
  }
  const a = countsOf(JSON.parse(readFileSync(first, "utf8")));
  console.log(lines(a).join("\n"));
  if (second) {
    const b = countsOf(JSON.parse(readFileSync(second, "utf8")));
    const diff = differences(a, b);
    if (diff.length) {
      console.log(`\nNot equal:\n${diff.join("\n")}`);
      process.exit(1);
    }
    console.log("\nEqual: every line matches.");
  }
}
