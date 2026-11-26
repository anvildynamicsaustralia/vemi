// Times 20 searches against a signed-in copy and prints median and worst against 150 ms.
// Usage: node scripts/data/search-time.mjs <base-url> <cookie-file> [query]
// <base-url> is required and never defaulted: there is no remote address in this script.
// <cookie-file> holds the Cookie header value of a signed-in browser session; the script
// sends it as is and prints nothing from it. It reads no other file and calls no Cloudflare API.
// Exit 1 when the worst is over the budget or any search fails.
import { readFileSync } from "node:fs";

export const RUNS = 20;
export const BUDGET_MS = 150;

/** @param {string | undefined} raw */
export function parseBase(raw) {
  if (!raw) throw new Error("A base URL is required, for example http://localhost:8787");
  let u;
  try {
    u = new URL(raw);
  } catch {
    throw new Error(`Not a URL: ${raw}`);
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("The base URL must start with http or https.");
  return u.origin;
}

/** @param {number[]} xs */
export function stats(xs) {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return { median: s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2, worst: s[s.length - 1] };
}

/**
 * @param {{base: string, cookie: string, query?: string, runs?: number, fetchImpl?: typeof fetch}} o
 */
export async function timeSearches({ base, cookie, query = "task", runs = RUNS, fetchImpl = fetch }) {
  /** @type {number[]} */
  const times = [];
  for (let i = 0; i < runs; i++) {
    const start = performance.now();
    const res = await fetchImpl(`${base}/api/search?q=${encodeURIComponent(query)}`, { headers: { cookie } });
    await res.arrayBuffer();
    const ms = performance.now() - start;
    if (!res.ok) throw new Error(`Search answered ${res.status}. Is the cookie file a signed-in session?`);
    times.push(ms);
  }
  return { times, ...stats(times) };
}

const self = process.argv[1] ? process.argv[1].replace(/\\/g, "/").split("/").pop() : "";
if (self === "search-time.mjs") {
  try {
    const base = parseBase(process.argv[2]);
    const file = process.argv[3];
    if (!file) throw new Error("A cookie file is required.");
    const cookie = readFileSync(file, "utf8").trim();
    const r = await timeSearches({ base, cookie, query: process.argv[4] });
    console.log(`Searches: ${r.times.length}`);
    console.log(`Median: ${r.median.toFixed(1)} ms (budget ${BUDGET_MS})`);
    console.log(`Worst: ${r.worst.toFixed(1)} ms (budget ${BUDGET_MS})`);
    process.exit(r.worst > BUDGET_MS ? 1 : 0);
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    console.error("usage: node scripts/data/search-time.mjs <base-url> <cookie-file> [query]");
    process.exit(2);
  }
}
