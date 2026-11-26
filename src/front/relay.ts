/**
 * The relay: how the setup page reaches Cloudflare, because Cloudflare's API answers no browser
 * call from another origin. Two routes, no stored state beyond one counter:
 *
 *   POST /get/relay/start  a signed ticket for one setup (a day and a call budget); the day's
 *                          ticket count is the cap, held in the one KV namespace RELAY_DAY.
 *   POST /get/relay        one Cloudflare call per request, for a method and path on ALLOWED.
 *
 * The visitor's key arrives in the request body, goes to Cloudflare in one header and is never
 * logged, stored or sent back. Nothing here writes to the console, sets a cookie or allows
 * credentials.
 */

export const CLOUDFLARE = "https://api.cloudflare.com/client/v4";

/** The relay calls one setup may make. Generous for the six steps, their retries and file buckets. */
export const RELAY_BUDGET = 200;
/** Cloudflare's free Worker allowance a day, shared by every relay call. */
export const DAY_REQUESTS = 40_000;
/** Workers KV's free writes a day; one is spent on each ticket. */
export const KV_WRITES = 1_000;
/** A ticket is good for the rest of its UTC day, and never more than this long. */
export const TICKET_LIFE_MS = 2 * 60 * 60 * 1000;
/** KV takes one write a second to a key, so a refused counter write waits this long before its one retry. */
export const PUT_RETRY_MS = 1100;
/** The most one relay call may carry. The largest real call is the app's Worker file, a few megabytes. */
export const MAX_BODY_BYTES = 24 * 1024 * 1024;
/** How long Cloudflare gets to answer one relayed call. */
export const UPSTREAM_TIMEOUT_MS = 28_000;
export const BUSY = "Setup is busy today. Try tomorrow, or use the Deploy button.";

/**
 * Tickets a day: the request allowance divided by the budget, never above KV's writes.
 *
 * What this cap is, and is not. The ticket count is shared (one KV key a day), so no more than
 * this many setups can start. The calls a ticket has spent are counted in each isolate's own
 * memory, because a shared count of calls would cost a KV write a call and the free plan allows
 * 1,000 a day. So one ticket replayed across isolates can spend its budget once in each. The cap
 * is therefore a limit on honest setups, which use a small part of their budget, and not a hard
 * limit on calls. The rest is Cloudflare's own: past the free 100,000 requests a day the Worker
 * stops answering until the next UTC day, and nothing is charged. The ruling is to state this
 * limit rather than claim a global one (notes_cleanup_rulings.md, 22 Nov 2026).
 */
export function ticketCap(budget: number = RELAY_BUDGET): number {
  return Math.min(Math.floor(DAY_REQUESTS / budget), KV_WRITES);
}

export interface Allowed {
  method: string;
  /** Path after /client/v4, with `:id` for one id or name segment. */
  path: string;
  /** The one query string this call may carry, if any. */
  query?: RegExp;
}

/** Exactly the calls `src/shared/setup/cloudflareApi.ts` makes, and no others. */
export const ALLOWED: readonly Allowed[] = [
  { method: "GET", path: "/user/tokens/verify" },
  { method: "GET", path: "/accounts", query: /^per_page=\d{1,3}$/ },
  { method: "GET", path: "/accounts/:id/workers/subdomain" },
  { method: "PUT", path: "/accounts/:id/workers/subdomain" },
  { method: "GET", path: "/accounts/:id/d1/database", query: /^name=[A-Za-z0-9_-]{1,64}$/ },
  { method: "POST", path: "/accounts/:id/d1/database" },
  { method: "POST", path: "/accounts/:id/d1/database/:id/query" },
  { method: "POST", path: "/accounts/:id/workers/scripts/:id/assets-upload-session" },
  { method: "POST", path: "/accounts/:id/workers/assets/upload", query: /^base64=true$/ },
  { method: "GET", path: "/accounts/:id/workers/scripts/:id/settings" },
  { method: "PUT", path: "/accounts/:id/workers/scripts/:id" },
  { method: "GET", path: "/accounts/:id/workers/scripts/:id/schedules" },
  { method: "PUT", path: "/accounts/:id/workers/scripts/:id/schedules" },
  { method: "GET", path: "/accounts/:id/workers/scripts/:id/subdomain" },
  { method: "POST", path: "/accounts/:id/workers/scripts/:id/subdomain" },
];

const SEGMENT = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * The Cloudflare address for `method` and `path` (as the page sends it, with any query), or null
 * when the call is not on the list. A path that escapes through `..`, an encoded slash or dot, a
 * backslash, a second slash or a scheme can never match, because each segment is plain letters,
 * digits, `_` and `-` only.
 */
export function target(method: unknown, path: unknown): string | null {
  if (typeof method !== "string" || typeof path !== "string") return null;
  if (!path.startsWith("/") || path.length > 512) return null;
  const [pathname = "", ...rest] = path.split("?");
  if (rest.length > 1) return null;
  const query = rest[0];
  const parts = pathname.slice(1).split("/");
  for (const entry of ALLOWED) {
    if (entry.method !== method.toUpperCase()) continue;
    const pattern = entry.path.slice(1).split("/");
    if (pattern.length !== parts.length) continue;
    const fits = pattern.every((p, i) => (p === ":id" ? SEGMENT.test(parts[i]!) : p === parts[i]));
    if (!fits) continue;
    if (query !== undefined && !(entry.query?.test(query) ?? false)) continue;
    return `${CLOUDFLARE}${pathname}${query === undefined ? "" : `?${query}`}`;
  }
  return null;
}

// ----- tickets -----

export interface Ticket {
  id: string;
  day: string;
  exp: number;
  budget: number;
}

const encoder = new TextEncoder();

function b64url(bytes: Uint8Array): string {
  let text = "";
  for (const b of bytes) text += String.fromCharCode(b);
  return btoa(text).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function unb64url(text: string): Uint8Array {
  const padded = text.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat((4 - (text.length % 4)) % 4);
  const raw = atob(padded);
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

export const dayOf = (now: Date): string => now.toISOString().slice(0, 10);

export async function signTicket(secret: string, ticket: Ticket): Promise<string> {
  const body = b64url(encoder.encode(JSON.stringify(ticket)));
  const mac = await crypto.subtle.sign("HMAC", await hmacKey(secret), encoder.encode(body));
  return `${body}.${b64url(new Uint8Array(mac))}`;
}

/** The ticket inside `text`, or null when it is missing, forged, from another day or out of time. */
export async function readTicket(secret: string, text: unknown, now: Date): Promise<Ticket | null> {
  if (typeof text !== "string" || text.length > 1024) return null;
  const [body, mac, extra] = text.split(".");
  if (!body || !mac || extra !== undefined) return null;
  try {
    const good = await crypto.subtle.verify("HMAC", await hmacKey(secret), unb64url(mac), encoder.encode(body));
    if (!good) return null;
    const ticket = JSON.parse(new TextDecoder().decode(unb64url(body))) as Ticket;
    if (typeof ticket.id !== "string" || ticket.day !== dayOf(now) || !(ticket.exp > now.getTime()) || !(ticket.budget > 0)) return null;
    return ticket;
  } catch {
    return null;
  }
}

// ----- the handlers -----

export interface KeyValue {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
}

export interface RelayDeps {
  secret: string;
  day: KeyValue;
  now: () => Date;
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  /** The front's own origin: the one page that may call the relay from a browser. */
  origin: string;
  /** Pauses between the two tries at the counter; replaced in tests. */
  wait?: (ms: number) => Promise<void>;
}

const NO_STORE = { "cache-control": "no-store" };

function reply(deps: RelayDeps, request: Request, status: number, text: string, type = "application/json"): Response {
  const headers: Record<string, string> = { ...NO_STORE, "content-type": type, vary: "origin" };
  if (request.headers.get("origin") === deps.origin) headers["access-control-allow-origin"] = deps.origin;
  // A response with a null-body status (204, 205, 304) must carry no body, or the constructor throws.
  return new Response(status === 204 || status === 205 || status === 304 ? null : text, { status, headers });
}

const said = (deps: RelayDeps, request: Request, status: number, error: string): Response =>
  reply(deps, request, status, JSON.stringify({ error }));

/** A small sliding-window count per visitor. Per instance, so a courtesy, not the cap. */
function limiter(limit: number, windowMs: number) {
  const seen = new Map<string, number[]>();
  return (who: string, at: number): boolean => {
    const recent = (seen.get(who) ?? []).filter((t) => at - t < windowMs);
    if (recent.length >= limit) {
      seen.set(who, recent);
      return false;
    }
    recent.push(at);
    seen.set(who, recent);
    if (seen.size > 5000) for (const [key, times] of seen) if (times.every((t) => at - t >= windowMs)) seen.delete(key);
    return true;
  };
}

interface Part {
  name: string;
  filename?: string;
  type?: string;
  text: string;
}

function isParts(value: unknown): value is Part[] {
  return (
    Array.isArray(value) &&
    value.length <= 2000 &&
    value.every((p) => p && typeof p === "object" && typeof (p as Part).name === "string" && typeof (p as Part).text === "string")
  );
}

export function createRelay(deps: RelayDeps) {
  const startLimit = limiter(5, 60_000);
  const callLimit = limiter(120, 60_000);
  const used = new Map<string, number>();
  const visitor = (request: Request): string => request.headers.get("cf-connecting-ip") ?? "unknown";

  async function json(request: Request): Promise<Record<string, unknown> | null> {
    if (!(request.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) return null;
    try {
      const value: unknown = await request.json();
      return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  }

  const wait = deps.wait ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  /**
   * Takes one of the day's ticket slots. KV allows one write a second to a key, so a refused
   * write is tried once more after a pause; a second refusal, or a counter that cannot be read,
   * answers busy. The count is read then written, not atomic, so a burst of starts in the same
   * moment can overshoot the cap by the few that raced; the per-visitor limit and the headroom in
   * the cap arithmetic absorb that.
   */
  async function takeSlot(key: string): Promise<boolean> {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const count = Number((await deps.day.get(key)) ?? "0") || 0;
        if (count >= ticketCap()) return false;
        await deps.day.put(key, String(count + 1), { expirationTtl: 2 * 24 * 60 * 60 });
        return true;
      } catch {
        if (attempt === 0) await wait(PUT_RETRY_MS);
      }
    }
    return false;
  }

  const foreign = (request: Request): boolean => {
    const from = request.headers.get("origin");
    return from !== null && from !== deps.origin;
  };

  return {
    /** Answers the browser's preflight for the page's own origin, without credentials. */
    preflight(request: Request): Response {
      const headers: Record<string, string> = { ...NO_STORE, vary: "origin" };
      if (request.headers.get("origin") === deps.origin) {
        headers["access-control-allow-origin"] = deps.origin;
        headers["access-control-allow-methods"] = "POST";
        headers["access-control-allow-headers"] = "content-type";
        headers["access-control-max-age"] = "600";
      }
      return new Response(null, { status: 204, headers });
    },

    async start(request: Request): Promise<Response> {
      if (foreign(request)) return said(deps, request, 403, "This page may not ask for setup.");
      const now = deps.now();
      if (!startLimit(visitor(request), now.getTime())) return said(deps, request, 429, "Too many tries. Wait a minute and try again.");
      if (!(await takeSlot(`tickets:${dayOf(now)}`))) return said(deps, request, 429, BUSY);
      const ticket: Ticket = { id: crypto.randomUUID(), day: dayOf(now), exp: now.getTime() + TICKET_LIFE_MS, budget: RELAY_BUDGET };
      return reply(deps, request, 200, JSON.stringify({ ticket: await signTicket(deps.secret, ticket), budget: ticket.budget }));
    },

    async forward(request: Request): Promise<Response> {
      if (foreign(request)) return said(deps, request, 403, "This page may not use the relay.");
      const now = deps.now();
      if (!callLimit(visitor(request), now.getTime())) return said(deps, request, 429, "Too many calls. Wait a minute and try again.");
      if (Number(request.headers.get("content-length") ?? "0") > MAX_BODY_BYTES) return said(deps, request, 413, "That call is too large for the relay.");
      const body = await json(request);
      if (body === null) return said(deps, request, 415, "The relay takes a JSON body.");
      const ticket = await readTicket(deps.secret, body.ticket, now);
      if (ticket === null) return said(deps, request, 403, "This setup has no ticket, or it has run out. Start again.");
      const token = body.token;
      if (typeof token !== "string" || token.length < 8 || token.length > 512 || /[\s,]/.test(token)) {
        return said(deps, request, 400, "The key is missing or not the right shape.");
      }
      const to = target(body.method, body.path);
      if (to === null) return said(deps, request, 400, "That call is not one the relay makes.");
      const spent = used.get(ticket.id) ?? 0;
      if (spent >= ticket.budget) return said(deps, request, 403, "This setup has run out of calls. Start again.");
      used.set(ticket.id, spent + 1);
      if (used.size > 5000) for (const id of used.keys()) { used.delete(id); if (used.size <= 2500) break; }

      const method = (body.method as string).toUpperCase();
      const headers: Record<string, string> = { authorization: `Bearer ${token}` };
      let payload: FormData | string | undefined;
      if (body.form !== undefined) {
        if (!isParts(body.form)) return said(deps, request, 400, "The relay could not read the files.");
        const form = new FormData();
        for (const part of body.form) form.append(part.name, new Blob([part.text], { type: part.type ?? "text/plain" }), part.filename ?? part.name);
        payload = form;
      } else if (body.body !== undefined) {
        headers["content-type"] = "application/json";
        payload = JSON.stringify(body.body);
      }
      // A session key for the file upload travels as `bearer`, in place of the account key.
      if (typeof body.bearer === "string" && body.bearer.length >= 8 && body.bearer.length <= 4096 && !/\s/.test(body.bearer)) {
        headers.authorization = `Bearer ${body.bearer}`;
      }

      let upstream: Response;
      try {
        upstream = await deps.fetch(to, { method, headers, body: payload, signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) });
      } catch {
        return said(deps, request, 502, "Cloudflare could not be reached.");
      }
      let text = await upstream.text();
      for (const secret of [token, typeof body.bearer === "string" ? body.bearer : ""]) {
        if (secret === "") continue;
        // Plain, and as it would read inside a JSON string.
        for (const form of new Set([secret, JSON.stringify(secret).slice(1, -1)])) text = text.split(form).join("");
      }
      return reply(deps, request, upstream.status, text);
    },
  };
}
