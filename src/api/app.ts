/**
 * The API, as a function from a request to a response.
 *
 * Built from a store, an identity and a live channel rather than from a Worker
 * environment, so every route runs in a test against a real D1 with nothing mocked, and
 * the Worker entry is the only file that knows where the pieces come from.
 *
 * Archiving is the reachable act and undoes itself. Deleting exists on one path only —
 * `DELETE <kind>/<id>`, on a record already archived, with its own name in the body — and
 * `GET <kind>/<id>/delete` says first what it would destroy. Decision 33.
 */
import { VERSION, isNewer, type Change, type Kind } from "@vemi/shared";
import type { Identity, Resolution } from "./identity.js";
import { capBody } from "./body.js";
import { MOVE_CODE_MS, MOVE_LIMIT, moveCodeId, newMoveCode } from "./move.js";
import { countLocked, isWallTime, MOVE_CODE_MARK, type Outcome, type ReminderAction, type Store, type Written } from "./store.js";
import { isDate, isKind, parseAppearance, parseCanvas, parseCreate, parseEncryptionStart, parseFillPairing, parseSealBatch, parseFirstRun, parseFront, parseKeyBundle, parseOpenPairing, parsePairingId, parseRecoveryWrap, parseFilterRename, parseNewFilter, parsePatch, parsePushEndpoint, parsePushSubscription, parseRestore, sentJson } from "./validate.js";
import { vapidKeys, type VapidSecrets } from "./vapid.js";
import { sendTest } from "./reminders.js";
import { updateRoute } from "./updateRoutes.js";
import type { SelfUpdate } from "./selfUpdate.js";
import { createConnector } from "./connectorOauth.js";
import { createMcp } from "./connectorMcp.js";
import { createChanges } from "./connectorChanges.js";

export interface LiveChannel {
  /** Tell every open client of this owner what changed. */
  publish(owner: string, change: Change): Promise<void>;
  /** Hand a WebSocket upgrade to the owner's channel. */
  connect(owner: string, request: Request): Promise<Response>;
}

export interface AppDeps {
  readonly store: Store;
  readonly identity: Identity;
  readonly live: LiveChannel;
  /** The page's own origin. A write or a WebSocket from anywhere else is refused. */
  readonly origin: string;
  /** Whose midnight "today" turns over at when the page does not say its own (`?tz=`). */
  readonly timeZone: string;
  readonly now: () => Date;
  /** The account that owns this copy. It cannot schedule its own deletion: nobody would be left to invite or reset. */
  readonly copyOwner?: string;
  /** Push keys set as secrets. Without them the pair kept in D1 is used. */
  readonly vapid?: VapidSecrets;
  /** What push messages are posted with. Tests give a fake push endpoint. */
  readonly push?: typeof fetch;
  /** What an app's published client page is read with. Defaults to the runtime's own fetch. */
  readonly fetch?: typeof fetch;
  /**
   * Whether a request came from the page itself. Asked for every write and every socket. The
   * default is the Worker's rule: its `Origin` header is `origin`. A copy that runs inside the
   * page has no `Origin` to read (a browser drops it from a script's request) and answers true,
   * because nothing but the page can reach it.
   */
  readonly sameOrigin?: (request: Request) => boolean;
  /** The setup page's hand-over, present only on a copy that has `SETUP_CLAIM` set. */
  readonly setup?: { handle(request: Request): Promise<Response | null> };
  /** The copy updating itself, present only on a copy that has `SETUP_CLAIM` set. */
  readonly update?: SelfUpdate;
}

export type App = (request: Request, waitUntil: (work: Promise<unknown>) => void) => Promise<Response>;

/** `YYYY-MM-DD` in a time zone. */
export function localDate(at: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(at);
}

/**
 * The time zone a request's "today" is in. Every account reads its own day: the page sends
 * its device's zone as `?tz=`, an IANA name, and the Worker still works the date out, so
 * there is one place that decides what today is. A name this runtime does not know, or none,
 * falls back to `fallback`.
 */
export function zoneOf(url: URL, fallback: string): string {
  const asked = url.searchParams.get("tz");
  if (asked === null || asked === "" || asked.length > 64) return fallback;
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: asked });
    return asked;
  } catch {
    return fallback;
  }
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

/** Headers every response carries. */
function hardened(response: Response): Response {
  if (response.status === 101) return response;
  const out = new Response(response.body, response);
  out.headers.set("x-content-type-options", "nosniff");
  out.headers.set("referrer-policy", "no-referrer");
  out.headers.set("x-frame-options", "DENY");
  // Nothing the Worker answers is a page: it is JSON, a redirect or a socket, so no script, frame or form may run from it.
  out.headers.set("content-security-policy", "default-src 'none'; frame-ancestors 'none'; base-uri 'none'");
  out.headers.set("strict-transport-security", "max-age=31536000");
  out.headers.set("permissions-policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=()");
  out.headers.set("cross-origin-resource-policy", "same-origin");
  if (!out.headers.has("cache-control")) out.headers.set("cache-control", "no-store");
  return out;
}

/** The body of `POST /api/push/act`: the task, what to do, and the wall time it reminded at. */
function parseAct(body: unknown):
  { ok: true; taskId: string; action: ReminderAction; at: string } | { ok: false; error: string } {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return { ok: false, error: "send { taskId, action, at }" };
  const o = body as Record<string, unknown>;
  for (const key of Object.keys(o)) {
    if (!["taskId", "action", "at"].includes(key)) return { ok: false, error: `an act has no ${key}` };
  }
  if (typeof o.taskId !== "string" || o.taskId === "" || o.taskId.length > 128) return { ok: false, error: "taskId must be a task's id" };
  if (o.action !== "done" && o.action !== "snooze") return { ok: false, error: "action must be done or snooze" };
  if (typeof o.at !== "string" || !isWallTime(o.at)) return { ok: false, error: "at must be a time as YYYY-MM-DDTHH:MM" };
  return { ok: true, taskId: o.taskId, action: o.action, at: o.at };
}

/**
 * Whether a request only reads, so it may run beside the session check rather than after it.
 * A GET changes nothing, except the live channel's upgrade, which hands the socket on before
 * any answer is sent and so must wait for the check like a write does.
 */
function readOnly(request: Request, url: URL): boolean {
  if (request.method !== "GET") return false;
  const segments = url.pathname.split("/").filter((s) => s !== "").slice(1);
  return !(segments.length === 1 && segments[0] === "live");
}

/** The most a write to the API may carry: far above any real one (a batch of sealed tasks is a few MB at most). A restore may carry a whole export. */
const API_BODY_MAX = 8 * 1024 * 1024;

export function createApp(deps: AppDeps): App {
  const { store } = deps;
  const sameOrigin = deps.sameOrigin ?? ((request: Request) => request.headers.get("origin") === deps.origin);
  const connector = createConnector({ store, origin: deps.origin, now: deps.now, fetch: deps.fetch ?? ((input, init) => fetch(input, init)) });
  // Everything published below is a connected app's write or the undo of one.
  const publish = (owner: string, change: Change) => deps.live.publish(owner, { ...change, via: "connector" });
  const changes = createChanges({ store, now: deps.now, publish });
  const mcp = createMcp({ store, origin: deps.origin, now: deps.now, timeZone: deps.timeZone, publish, changes });

  const answer = <T>(outcome: Outcome<T>, status = 200): Response =>
    outcome.ok ? json(status, outcome.value) : json(outcome.status, { error: outcome.error });

  /**
   * The zone a request's "today" is in: the one it names with `?tz=`, else the account's own,
   * else the Worker's. The account is only asked when the request names no zone.
   */
  async function zoneFor(from: Store, owner: string, url: URL): Promise<string> {
    const asked = zoneOf(url, "");
    if (asked !== "") return asked;
    return (await from.appearance(owner)).timeZone ?? deps.timeZone;
  }

  async function readJson(request: Request, limit: number = API_BODY_MAX): Promise<{ ok: true; body: unknown } | { ok: false; response: Response }> {
    if (!sentJson(request)) {
      return { ok: false, response: json(415, { error: "send JSON, with content-type: application/json" }) };
    }
    // Read under a ceiling, so one request cannot make the Worker hold a body of any size.
    const capped = await capBody(request, limit);
    if (!capped.ok) return { ok: false, response: capped.response };
    try {
      return { ok: true, body: JSON.parse(capped.text) as unknown };
    } catch {
      return { ok: false, response: json(400, { error: "the body is not valid JSON" }) };
    }
  }

  function written<K extends Kind>(
    owner: string, kind: K, outcome: Outcome<Written<{ id: string }>>, status: number,
    waitUntil: (work: Promise<unknown>) => void,
  ): Response {
    if (!outcome.ok) return json(outcome.status, { error: outcome.error });
    // A repeated create changed nothing, and every open client already heard about the first.
    if (outcome.value.replayed === true) return json(status, outcome.value.record);
    const change: Change = { kind, id: outcome.value.record.id, ventureId: outcome.value.ventureId };
    waitUntil(deps.live.publish(owner, change));
    const spawned = outcome.value.spawned;
    if (spawned === undefined) return json(status, outcome.value.record);
    // Finishing a repeating task made the next one in the same call: it is answered beside
    // the task, and every open client hears of it too.
    waitUntil(deps.live.publish(owner, { kind: "tasks", id: spawned.id, ventureId: outcome.value.ventureId }));
    return json(status, { ...outcome.value.record, spawned });
  }

  async function route(
    store: Store, owner: string, request: Request, url: URL, waitUntil: (work: Promise<unknown>) => void,
  ): Promise<Response> {
    const segments = url.pathname.split("/").filter((s) => s !== "").slice(1);
    const [first, second, third] = segments;
    const method = request.method;

    // Who an app says it is, for the consent page to name. Reads, and stores nothing.
    if (first === "connector" && second === "client" && segments.length === 2) {
      if (method !== "GET") return json(405, { error: "GET connector/client" });
      const name = await connector.client(url.searchParams.get("id") ?? "", url.searchParams.get("redirect_uri") ?? "");
      return name === null ? json(404, { error: "that app is not one this server knows" }) : json(200, { name });
    }

    // The person's Allow or Deny for an app waiting to be let in. Session and Origin were checked above.
    if (first === "connector" && second === "consent" && segments.length === 2) {
      if (method !== "POST") return json(405, { error: "POST connector/consent" });
      const body = await readJson(request);
      return body.ok ? connector.consent(owner, body.body) : body.response;
    }

    // The apps let in, and turning one off. Nothing of the tokens leaves the Worker.
    if (first === "connector" && second === "grants") {
      if (segments.length === 2) {
        if (method !== "GET") return json(405, { error: "GET connector/grants" });
        const grants = (await store.grants(owner)).map((g) => ({
          id: g.id, clientName: g.clientName, createdAt: g.createdAt, lastUsedAt: g.lastUsedAt,
        }));
        return json(200, { grants });
      }
      if (segments.length === 4 && segments[3] === "revoke" && third !== undefined) {
        if (method !== "POST") return json(405, { error: "POST connector/grants/:id/revoke" });
        return (await store.revokeGrant(owner, third))
          ? json(200, { id: third })
          : json(404, { error: "that app was not found" });
      }
    }

    // What apps did for this person: the last 7 days, and taking one back.
    if (first === "connector" && second === "changes") {
      if (segments.length === 2) {
        if (method !== "GET") return json(405, { error: "GET connector/changes" });
        return json(200, { changes: await changes.list(owner) });
      }
      if (segments.length === 4 && segments[3] === "undo" && third !== undefined) {
        if (method !== "POST") return json(405, { error: "POST connector/changes/:id/undo" });
        return answer(await changes.undo(owner, third));
      }
    }

    // Reminders. A device names its subscription by endpoint in a body, so these sit above the
    // DELETE rule below, which wants a record kind.
    if (first === "push") {
      if (segments.length === 2 && second === "key") {
        if (method !== "GET") return json(405, { error: "GET push/key" });
        return json(200, { publicKey: (await vapidKeys(store, deps.vapid)).publicKey });
      }
      if (segments.length === 2 && second === "subscriptions") {
        if (method !== "GET") return json(405, { error: "GET push/subscriptions" });
        return json(200, { subscriptions: await store.pushSubscriptions(owner) });
      }
      if (segments.length === 2 && second === "test") {
        if (method !== "POST") return json(405, { error: "POST push/test" });
        const keys = await vapidKeys(store, deps.vapid);
        const result = await sendTest(store, owner, { ...keys, subject: deps.origin }, deps.now(), deps.push);
        return json(200, result);
      }
      if (segments.length === 2 && second === "act") {
        if (method !== "POST") return json(405, { error: "POST push/act" });
        const body = await readJson(request);
        if (!body.ok) return body.response;
        const act = parseAct(body.body);
        if (!act.ok) return json(400, { error: act.error });
        const today = localDate(deps.now(), await zoneFor(store, owner, url));
        return written(owner, "tasks", await store.actOnReminder(owner, act.taskId, act.action, act.at, today), 200, waitUntil);
      }
      if (segments.length === 2 && second === "subscribe") {
        if (method !== "POST" && method !== "DELETE") return json(405, { error: "POST or DELETE push/subscribe" });
        const body = await readJson(request);
        if (!body.ok) return body.response;
        if (method === "POST") {
          const sub = parsePushSubscription(body.body, await zoneFor(store, owner, url));
          if (!sub.ok) return json(400, { error: sub.error });
          return json(200, await store.subscribePush(owner, sub.value));
        }
        const endpoint = parsePushEndpoint(body.body);
        if (!endpoint.ok) return json(400, { error: endpoint.error });
        return (await store.unsubscribePush(owner, endpoint.value))
          ? json(200, { subscriptions: await store.pushSubscriptions(owner) })
          : json(404, { error: "this device has no subscription" });
      }
      return json(404, { error: "not found" });
    }

    // Saved filters. A delete names its filter with no body, so these sit above the DELETE rule.
    if (first === "filters") {
      if (segments.length === 2 && second === "dates") {
        if (method !== "GET") return json(405, { error: "GET filters/dates" });
        const on = url.searchParams.get("on");
        if (on !== null && !isDate(on)) return json(400, { error: "on must be a date, YYYY-MM-DD" });
        return json(200, await store.dateFilters(owner, on ?? localDate(deps.now(), await zoneFor(store, owner, url))));
      }
      if (segments.length === 1) {
        if (method === "GET") return json(200, { filters: await store.filters(owner) });
        if (method !== "POST") return json(405, { error: "GET or POST filters" });
        const body = await readJson(request);
        if (!body.ok) return body.response;
        const input = parseNewFilter(body.body);
        if (!input.ok) return json(400, { error: input.error });
        return answer(await store.createFilter(owner, input.value), 201);
      }
      if (segments.length === 2 && second !== undefined) {
        if (method === "PATCH") {
          const body = await readJson(request);
          if (!body.ok) return body.response;
          const name = parseFilterRename(body.body);
          if (!name.ok) return json(400, { error: name.error });
          return answer(await store.renameFilter(owner, second, name.value));
        }
        if (method === "DELETE") {
          return (await store.removeFilter(owner, second))
            ? json(200, { id: second })
            : json(404, { error: "that saved filter does not exist" });
        }
        return json(405, { error: "PATCH or DELETE filters/<id>" });
      }
      return json(404, { error: "not found" });
    }

    // Decision 33. A delete names its record and needs that name typed, so it carries a
    // body like a write does; every other shape of DELETE is refused with the one that works.
    if (method === "DELETE") {
      if (segments.length !== 2 || first === undefined || !isKind(first) || second === undefined) {
        return json(405, { error: "DELETE <kind>/<id> with { confirm }, on something already archived" });
      }
      const body = await readJson(request);
      if (!body.ok) return body.response;
      // A body of `null`, a list or a bare string has no `confirm` to read.
      const confirm = typeof body.body === "object" && body.body !== null ? (body.body as { confirm?: unknown }).confirm : undefined;
      if (typeof confirm !== "string") {
        return json(400, { error: "confirm must be the record's name, as the preview gives it" });
      }
      const gone = await store.remove(owner, first, second, confirm);
      if (!gone.ok) return json(gone.status, { error: gone.error });
      // The same change every write publishes: an open client drops what it is holding.
      waitUntil(deps.live.publish(owner, { kind: first, id: second, ventureId: gone.value.ventureId }));
      return json(200, { removes: gone.value.removes });
    }

    if (segments.length === 1 && first === "appearance") {
      if (method === "GET") return json(200, await store.appearance(owner));
      if (method !== "PATCH") return json(405, { error: "GET or PATCH appearance" });
      const body = await readJson(request);
      if (!body.ok) return body.response;
      const change = parseAppearance(body.body);
      if (!change.ok) return json(400, { error: change.error });
      const saved = await store.setAppearance(owner, change.value);
      return saved.ok ? json(200, saved.value) : json(saved.status, { error: saved.error });
    }

    // Full encryption: where the account is, and the device's batches of sealed text. The server
    // only ever holds what it is given and counts what is left; the device does the sealing.
    if (first === "encryption") {
      if (segments.length === 1) {
        if (method !== "GET") return json(405, { error: "GET encryption" });
        return json(200, await store.encryption(owner));
      }
      if (segments.length === 2 && (second === "start" || second === "batch" || second === "finish")) {
        if (method !== "POST") return json(405, { error: `POST encryption/${second}` });
        if (second === "finish") {
          const finished = await store.finishEncryption(owner);
          if (finished.ok) {
            waitUntil(deps.live.publish(owner, { kind: "ventures", id: "encryption", ventureId: null }));
            return json(200, finished.value);
          }
          return json(finished.status, { error: finished.error, ...(await store.encryption(owner)) });
        }
        const body = await readJson(request);
        if (!body.ok) return body.response;
        if (second === "start") {
          const to = parseEncryptionStart(body.body);
          if (!to.ok) return json(400, { error: to.error });
          const started = await store.startEncryption(owner, to.value);
          return started.ok ? json(200, started.value) : json(started.status, { error: started.error });
        }
        const batch = parseSealBatch(body.body);
        if (!batch.ok) return json(400, { error: batch.error });
        const written = await store.sealBatch(owner, batch.value);
        return written.ok ? json(200, written.value) : json(written.status, { error: written.error });
      }
    }

    if (segments.length === 1 && first === "first-run") {
      if (method === "GET") return json(200, await store.firstRun(owner));
      if (method !== "PATCH") return json(405, { error: "GET or PATCH first-run" });
      const body = await readJson(request);
      if (!body.ok) return body.response;
      const change = parseFirstRun(body.body);
      if (!change.ok) return json(400, { error: change.error });
      const saved = await store.setFirstRun(owner, change.value);
      return saved.ok ? json(200, saved.value) : json(saved.status, { error: saved.error });
    }

    // Wrapped copies of the account key. The server holds ciphertext and public references only.
    if (first === "keys") {
      if (segments.length === 1) {
        if (method === "GET") return json(200, await store.keys(owner));
        if (method !== "POST") return json(405, { error: "GET or POST keys" });
        const body = await readJson(request);
        if (!body.ok) return body.response;
        const bundle = parseKeyBundle(body.body);
        if (!bundle.ok) return json(400, { error: bundle.error });
        const saved = await store.addKeys(owner, bundle.value);
        return saved.ok ? json(200, saved.value) : json(saved.status, { error: saved.error });
      }
      if (segments.length === 2 && (second === "recovery" || second === "start-again")) {
        if (method !== "POST") return json(405, { error: `POST keys/${second}` });
        const body = await readJson(request);
        if (!body.ok) return body.response;
        if (second === "recovery") {
          const wrap = parseRecoveryWrap(body.body);
          if (!wrap.ok) return json(400, { error: wrap.error });
          const saved = await store.replaceRecovery(owner, wrap.value);
          return saved.ok ? json(200, saved.value) : json(saved.status, { error: saved.error });
        }
        const bundle = parseKeyBundle(body.body);
        if (!bundle.ok) return json(400, { error: bundle.error });
        const saved = await store.startAgain(owner, bundle.value);
        return saved.ok ? json(200, saved.value) : json(saved.status, { error: saved.error });
      }
      if (segments.length === 3 && second !== undefined && third === "archive") {
        if (method !== "POST") return json(405, { error: "POST keys/:id/archive" });
        const saved = await store.archiveKey(owner, second);
        return saved.ok ? json(200, saved.value) : json(saved.status, { error: saved.error });
      }
    }

    // One sealed copy relayed to a new device for ten minutes, read once.
    if (first === "key-pairing") {
      if (segments.length === 1) {
        if (method !== "POST") return json(405, { error: "POST key-pairing" });
        const body = await readJson(request);
        if (!body.ok) return body.response;
        const id = parseOpenPairing(body.body);
        if (!id.ok) return json(400, { error: id.error });
        const saved = await store.openPairing(owner, id.value);
        return saved.ok ? json(200, saved.value) : json(saved.status, { error: saved.error });
      }
      if (segments.length === 2 && second !== undefined) {
        if (method !== "PUT" && method !== "GET") return json(405, { error: "GET or PUT key-pairing/:id" });
        const id = parsePairingId(second);
        if (!id.ok) return json(404, { error: "no such pairing" });
        if (method === "GET") {
          const read = await store.readPairing(owner, id.value);
          return read.ok ? json(200, read.value) : json(read.status, { error: read.error });
        }
        const body = await readJson(request);
        if (!body.ok) return body.response;
        const parts = parseFillPairing(body.body);
        if (!parts.ok) return json(400, { error: parts.error });
        const saved = await store.fillPairing(owner, id.value, parts.value);
        return saved.ok ? json(200, saved.value) : json(saved.status, { error: saved.error });
      }
    }

    if (segments.length === 1 && first === "move-code") {
      if (method !== "POST") return json(405, { error: "POST move-code" });
      // Any signed-in account may make one, for itself: it is spent on the account that made it.
      const code = newMoveCode();
      const expiresAt = new Date(deps.now().getTime() + MOVE_CODE_MS).toISOString();
      await store.putEmailToken({ id: await moveCodeId(code), owner, purpose: "confirm", email: MOVE_CODE_MARK, expiresAt });
      return json(200, { code, expiresAt });
    }

    if (segments.length === 1 && first === "restore") {
      if (method !== "POST") return json(405, { error: "POST restore" });
      const body = await readJson(request, MOVE_LIMIT);
      if (!body.ok) return body.response;
      const asked = parseRestore(body.body);
      if (!asked.ok) return json(400, { error: asked.error });
      // Without the word, nothing is touched: the answer is what the file holds, so the person can see it first.
      if (!asked.value.confirmed) {
        const counts = Object.fromEntries(Object.entries(asked.value.file.tables).map(([name, rows]) => [name, rows.length]));
        return json(200, { restored: false, counts, locked: countLocked(asked.value.file.tables), confirm: "replace" });
      }
      const done = await store.restoreAll(owner, asked.value.file);
      if (!done.ok) return json(done.status, { error: done.error });
      waitUntil(deps.live.publish(owner, { kind: "ventures", id: "restore", ventureId: null }));
      return json(200, { restored: true, counts: done.value.counts, locked: done.value.locked, ids: done.value.ids });
    }

    // The front page setting. The read is answered before the session check (see the handler);
    // here only the copy's owner may change it.
    if (first === "front" && segments.length === 1) {
      if (method !== "PATCH") return json(405, { error: "GET or PATCH front" });
      if (deps.copyOwner === undefined || deps.copyOwner === "" || deps.copyOwner !== owner) {
        return json(403, { error: "Only the owner can do this." });
      }
      const body = await readJson(request);
      if (!body.ok) return body.response;
      const parsed = parseFront(body.body);
      if (!parsed.ok) return json(400, { error: parsed.error });
      return json(200, { landing: await store.setFrontLanding(parsed.value.landing) });
    }

    // What version this copy is and whether a signed newer one waits. Any signed-in person may ask;
    // only the owner of a copy that kept its key can update. Never carries the key, a token, or an address.
    if (first === "update" && segments.length === 1) {
      if (method !== "GET") return json(405, { error: "GET update" });
      const [checked, claim, run] = await Promise.all([store.updateCheck(), store.setupClaim(), store.updateRun()]);
      let offer: { version: string; notes: string } | null = null;
      // A stored offer that is not newer than this copy (the daily job has not cleared it yet) is no offer.
      if (checked?.offer != null && isNewer(checked.offer.version, VERSION)) {
        try {
          const notes = (JSON.parse(checked.offer.manifest) as { notes?: unknown }).notes;
          offer = { version: checked.offer.version, notes: typeof notes === "string" ? notes : "" };
        } catch {
          offer = null;
        }
      }
      const isOwner = deps.copyOwner !== undefined && deps.copyOwner !== "" && deps.copyOwner === owner;
      const now = deps.now().toISOString();
      const goBack = run !== null && run.step === "done" && run.state === "done" && run.previousVersionId !== null
        && run.previousVersion !== null && run.backUntil !== null && run.backUntil > now;
      return json(200, {
        current: VERSION,
        offer,
        canUpdate: isOwner && claim?.sealedToken != null,
        auto: claim?.keepUpdated === true,
        back: goBack,
        // What the Go back row says, only for the owner: the release it returns to, until when, and the
        // restore point when the update changed the data.
        goBack: isOwner && goBack
          ? { version: run.previousVersion, until: run.backUntil, restorePoint: run.migrated > 0 ? run.bookmark : null }
          : null,
        // The copy went back from its last update and runs that older release now.
        backed: isOwner && run !== null && run.state === "back" ? run.previousVersion : null,
        // Update myself is On for a copy that kept a key, and only the owner is told.
        keyKept: isOwner && claim?.sealedToken != null,
      });
    }

    // The two writes that update the copy. Owner only; the answer is the step, never the key.
    if (first === "update" && segments.length === 2) {
      let sent: unknown;
      if (second === "off" && method === "POST") {
        // A body that cannot be read is refused by the route after it has checked who is asking.
        const body = await readJson(request);
        sent = body.ok ? body.body : undefined;
      }
      const answered = await updateRoute(deps, owner, method, second, sent);
      if (answered !== null) return json(answered.status, answered.body);
    }

    if (first === "deletion" && (segments.length === 1 || (segments.length === 2 && second === "cancel"))) {
      if (segments.length === 2) {
        if (method !== "POST") return json(405, { error: "POST deletion/cancel" });
        await store.cancelDeletion(owner);
        return json(200, { deleteOn: null });
      }
      if (method === "GET") return json(200, { deleteOn: await store.deletion(owner) });
      if (method !== "POST") return json(405, { error: "GET or POST deletion" });
      if (deps.copyOwner !== undefined && deps.copyOwner !== "" && deps.copyOwner === owner) {
        return json(403, { error: "The owner of this copy cannot delete their account." });
      }
      const scheduled = await store.scheduleDeletion(owner);
      return scheduled.ok ? json(200, { deleteOn: scheduled.value.deleteOn }) : json(scheduled.status, { error: scheduled.error });
    }

    if (segments.length === 1 && first === "canvas") {
      if (method === "GET") return json(200, { positions: await store.canvas(owner) });
      if (method !== "PUT") return json(405, { error: "GET or PUT canvas" });
      const body = await readJson(request);
      if (!body.ok) return body.response;
      const change = parseCanvas(body.body);
      if (!change.ok) return json(400, { error: change.error });
      const saved = await store.setCanvas(owner, change.value);
      return saved.ok ? json(200, { positions: saved.value }) : json(saved.status, { error: saved.error });
    }

    if (segments.length === 1 && first !== undefined && !isKind(first)) {
      if (method !== "GET") return json(405, { error: `${first} is read-only` });
      switch (first) {
        case "overview": return json(200, await store.overview(owner));
        case "tree": return json(200, await store.tree(owner));
        case "today": {
          const on = url.searchParams.get("on");
          if (on !== null && !isDate(on)) return json(400, { error: "on must be a date, YYYY-MM-DD" });
          return json(200, await store.today(owner, on ?? localDate(deps.now(), await zoneFor(store, owner, url))));
        }
        case "search": return json(200, { results: await store.search(owner, url.searchParams.get("q") ?? "") });
        case "archived": return json(200, { items: await store.archived(owner) });
        case "locked": return json(200, await store.locked(owner));
        case "export": {
          const doc = await store.exportAll(owner, deps.now());
          // The viewer's own day names the file.
          const on = localDate(deps.now(), await zoneFor(store, owner, url));
          const filename = `vemi-export-${on}.json`;
          return new Response(JSON.stringify(doc, null, 2), {
            status: 200,
            headers: {
              "content-type": "application/json; charset=utf-8",
              "content-disposition": `attachment; filename="${filename}"`,
            },
          });
        }
        case "live": {
          if ((request.headers.get("upgrade") ?? "").toLowerCase() !== "websocket") {
            return json(426, { error: "this is a WebSocket" });
          }
          if (!sameOrigin(request)) return json(403, { error: "cross-origin WebSocket refused" });
          return deps.live.connect(owner, request);
        }
        default: return json(404, { error: "not found" });
      }
    }

    if (first === undefined || !isKind(first)) return json(404, { error: "not found" });
    const kind = first;

    if (segments.length === 1) {
      if (method === "GET") {
        return answer(await store.list(owner, kind, Object.fromEntries(url.searchParams)));
      }
      if (method === "POST") {
        const body = await readJson(request);
        if (!body.ok) return body.response;
        const input = parseCreate(kind, body.body);
        if (!input.ok) return json(400, { error: input.error });
        return written(owner, kind, await store.create(owner, kind, input.value), 201, waitUntil);
      }
      return json(405, { error: `GET or POST ${kind}` });
    }

    if (segments.length === 2 && second !== undefined) {
      if (method === "GET") {
        const record = await store.get(owner, kind, second);
        return record === null ? json(404, { error: `${kind} ${second} was not found` }) : json(200, record);
      }
      if (method === "PATCH") {
        const body = await readJson(request);
        if (!body.ok) return body.response;
        const patch = parsePatch(kind, body.body);
        if (!patch.ok) return json(400, { error: patch.error });
        const today = localDate(deps.now(), await zoneFor(store, owner, url));
        return written(owner, kind, await store.update(owner, kind, second, patch.value, today), 200, waitUntil);
      }
      return json(405, { error: `GET or PATCH ${kind}/${second}` });
    }

    if (segments.length === 3 && second !== undefined && third === "delete") {
      if (method !== "GET") return json(405, { error: `GET ${kind}/${second}/delete, then DELETE ${kind}/${second}` });
      const preview = await store.deletePreview(owner, kind, second);
      return preview === null ? json(404, { error: `${kind} ${second} was not found` }) : json(200, preview);
    }

    if (segments.length === 3 && second !== undefined && (third === "archive" || third === "unarchive")) {
      if (method !== "POST") return json(405, { error: `POST ${kind}/${second}/${third}` });
      return written(owner, kind, await store.setArchived(owner, kind, second, third === "archive"), 200, waitUntil);
    }

    return json(404, { error: "not found" });
  }

  const handle: App = async (request, waitUntil) => {
    // An app arriving with a bearer token has no cookie and no Origin, so the connector's own
    // paths are answered before those checks, and answer for themselves.
    if (new URL(request.url).pathname === "/mcp") {
      const grant = await connector.bearer(request);
      if (grant !== null) return hardened(await mcp.handle(request, grant, waitUntil));
    }
    const connected = await connector.handle(request);
    if (connected !== null) return hardened(connected);

    const setUp = deps.setup === undefined ? null : await deps.setup.handle(request);
    if (setUp !== null) return hardened(setUp);

    const handled = await deps.identity.handle(request, waitUntil);
    if (handled !== null) return hardened(handled);

    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/")) return hardened(json(404, { error: "not found" }));
    // Every write must come from the page itself, as every auth write must. The session
    // cookie is SameSite=Strict, but a sibling subdomain is the same site; and archiving,
    // restoring and backing up carry no body, so a plain form elsewhere could send them.
    if (request.method !== "GET" && request.method !== "HEAD" && !sameOrigin(request)) {
      return hardened(json(403, { error: "cross-origin request refused" }));
    }

    // Whether the front page shows is public: a signed-out visitor asks it before any sign-in.
    if (request.method === "GET" && url.pathname === "/api/front") return hardened(json(200, { landing: await store.frontLanding() }));

    // A blank owner is a refusal, never a row stamped with nobody.
    const blank = json(401, { error: "Sign in first." });
    let resolved: Resolution;
    let routed: Response;
    if (readOnly(request, url)) {
      // The session check rides in the read's own round trip, and the answer waits for it.
      const read = await deps.identity.resolveRead(request, (owner, reading) =>
        owner.trim() === "" ? Promise.resolve(blank) : route(reading, owner.trim(), request, url, waitUntil));
      if ("refused" in read) return hardened(json(401, { error: read.refused }));
      if (read.read === blank) return hardened(blank);
      resolved = read;
      routed = read.read;
    } else {
      resolved = await deps.identity.resolve(request);
      if ("refused" in resolved) return hardened(json(401, { error: resolved.refused }));
      const owner = resolved.owner.trim();
      if (owner === "") return hardened(blank);
      routed = await route(store, owner, request, url, waitUntil);
    }
    const response = hardened(routed);
    // A WebSocket's 101 belongs to the channel and is passed on as it came.
    if (resolved.renew !== undefined && response.status !== 101) response.headers.append("set-cookie", resolved.renew);
    return response;
  };

  // Anything a route did not expect (a database that stopped answering, say) is answered in
  // the same JSON as every other refusal, with the cause in the Worker's log and not in the answer.
  return async (request, waitUntil) => {
    try {
      return await handle(request, waitUntil);
    } catch (error) {
      console.error(`${request.method} ${new URL(request.url).pathname}: ${error instanceof Error ? error.message : String(error)}`);
      return hardened(json(500, { error: "Something went wrong on the server. Try again in a moment." }));
    }
  };
}
