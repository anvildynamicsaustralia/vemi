// Turns a file of Workers tail events into markdown rows for hosting.md "Measured".
//
// Input: the file Andy saves from `wrangler tail --format json` (one JSON event per line;
// a JSON array of events is also read). Usage: node scripts/data/cpu-table.mjs <tail.json>
//
// Event shape, from Cloudflare's "Real-time logs" page (developers.cloudflare.com/workers/
// observability/logs/real-time-logs/, "The output of each wrangler tail log is a structured
// JSON object"): { outcome, scriptName, exceptions, logs, eventTimestamp (epoch ms),
// event: { request: { url, method, headers, cf } } }.
// CPU time: that page does not name a CPU field. The Workers Trace Events dataset
// (developers.cloudflare.com/logs/logpush/logpush-job/datasets/account/workers_trace_events/)
// names it `CPUTimeMs`, and the Tail Worker trace item `cpuTime`, both in milliseconds. This
// script reads `cpuTime`, then `CPUTimeMs`, and reports any event that has neither as
// "no CPU field" (never counted as 0). The field name is the one thing here not seen in a
// real tail: if a saved tail has no CPU field at all, say so to the next session.
import { readFileSync } from "node:fs";

export const LIMIT_MS = 10;

/** @param {string} text */
export function parseEvents(text) {
  const t = text.trim();
  if (t === "") return [];
  if (t.startsWith("[")) return JSON.parse(t);
  return t
    .split(/\r?\n/)
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l));
}

/** @param {string} pathname */
export function collapseIds(pathname) {
  return pathname
    .split("/")
    .map((s) =>
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s) ||
      /^[0-9a-f]{16,}$/i.test(s) ||
      /^\d+$/.test(s) ||
      (/^[A-Za-z0-9_-]{20,}$/.test(s) && /\d/.test(s))
        ? ":id"
        : s,
    )
    .join("/");
}

/** @param {any} ev */
function cpuOf(ev) {
  for (const k of ["cpuTime", "CPUTimeMs"]) {
    if (typeof ev?.[k] === "number" && Number.isFinite(ev[k])) return ev[k];
  }
  return null;
}

/** @param {number[]} xs sorted */
function median(xs) {
  const m = xs.length >> 1;
  return xs.length % 2 ? xs[m] : (xs[m - 1] + xs[m]) / 2;
}

/**
 * @param {any[]} events
 * @returns {{rows: {route:string, typical:number|null, worst:number|null, count:number, noCpu:number, date:string}[], skipped:number, flagged:string[]}}
 */
export function summarise(events) {
  /** @type {Map<string, {cpu:number[], noCpu:number, last:number}>} */
  const by = new Map();
  let skipped = 0;
  for (const ev of events) {
    const req = ev?.event?.request;
    if (!req || typeof req.url !== "string") {
      skipped++;
      continue;
    }
    let path;
    try {
      path = new URL(req.url).pathname;
    } catch {
      skipped++;
      continue;
    }
    const route = `${String(req.method ?? "GET").toUpperCase()} ${collapseIds(path)}`;
    const e = by.get(route) ?? { cpu: [], noCpu: 0, last: 0 };
    const cpu = cpuOf(ev);
    if (cpu === null) e.noCpu++;
    else e.cpu.push(cpu);
    if (typeof ev.eventTimestamp === "number") e.last = Math.max(e.last, ev.eventTimestamp);
    by.set(route, e);
  }
  const rows = [...by.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([route, e]) => {
      const sorted = [...e.cpu].sort((a, b) => a - b);
      return {
        route,
        typical: sorted.length ? median(sorted) : null,
        worst: sorted.length ? sorted[sorted.length - 1] : null,
        count: e.cpu.length + e.noCpu,
        noCpu: e.noCpu,
        date: e.last ? new Date(e.last).toISOString().slice(0, 10) : "",
      };
    });
  const flagged = rows.filter((r) => r.worst !== null && r.worst > LIMIT_MS).map((r) => r.route);
  return { rows, skipped, flagged };
}

/** @param {ReturnType<typeof summarise>} s */
export function render(s) {
  const out = ["| Route | CPU ms typical | worst seen | Count | Date |", "| --- | --- | --- | --- | --- |"];
  for (const r of s.rows) {
    const t = r.typical === null ? "no CPU field" : String(r.typical);
    const w = r.worst === null ? "no CPU field" : String(r.worst);
    const over = r.worst !== null && r.worst > LIMIT_MS ? " OVER 10" : "";
    const note = r.noCpu > 0 && r.worst !== null ? ` (${r.noCpu} without CPU field)` : "";
    out.push(`| ${r.route} | ${t} | ${w}${over} | ${r.count}${note} | ${r.date} |`);
  }
  if (s.skipped) out.push("", `${s.skipped} event(s) had no request and were left out.`);
  if (s.flagged.length) out.push("", `Over ${LIMIT_MS} ms worst seen: ${s.flagged.join(", ")}`);
  return out.join("\n");
}

const self = process.argv[1] ? process.argv[1].replace(/\\/g, "/").split("/").pop() : "";
if (self === "cpu-table.mjs") {
  const file = process.argv[2];
  if (!file) {
    console.error("usage: node scripts/data/cpu-table.mjs <tail.json>");
    process.exit(2);
  }
  const s = summarise(parseEvents(readFileSync(file, "utf8")));
  console.log(render(s));
  process.exit(s.flagged.length ? 1 : 0);
}
