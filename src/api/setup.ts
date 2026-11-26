/**
 * The hand-over from the setup page. A copy the setup page made has `SETUP_CLAIM` set to a
 * code only that page knows. `POST /setup/claim` takes `{ code, token, keepUpdated }` once:
 * until it has, nobody can sign up (see `claimable` in `accountIdentity.ts`).
 *
 * Every refusal is the same answer, so a wrong code, a second try and a closed door look
 * alike. Browsers may read the answer only from the one origin in `SETUP_FROM`, and only
 * while the copy is unclaimed. When the person asked to keep the copy updated, the token is
 * sealed with AES-GCM under a key derived from `SETUP_CLAIM` and the copy's own address;
 * otherwise nothing of it is stored.
 */

import type { Change } from "@vemi/shared";
import type { Identity } from "./identity.js";
import { capBody } from "./body.js";
import { capBytes, moveCodeId, moveCodeOk, moveCors } from "./move.js";
import { MOVE_CODE_MARK, type Store } from "./store.js";
import { fromBase64Url, toBase64Url } from "./vapid.js";
import { parseRestore, sentJson } from "./validate.js";

export interface SetupDeps {
  readonly store: Store;
  /** The `SETUP_CLAIM` secret. */
  readonly secret: string;
  /** `SETUP_FROM`: the one origin allowed to read the answer from a browser. Empty means none. */
  readonly from: string;
  /** The copy's own address. */
  readonly origin: string;
  /** What `/setup/move` needs: the owner account's id, who can make it, and how to tell the open pages. */
  readonly move?: {
    readonly owner: string;
    readonly identity: Identity;
    readonly publish: (owner: string, change: Change) => Promise<void>;
  };
}

export interface Setup {
  /** Answers `/setup/claim` and `/setup/move`, or null for any other path. */
  handle(request: Request): Promise<Response | null>;
}

const PATH = "/setup/claim";
const MOVE_PATH = "/setup/move";
const MAX_TOKEN = 4096;
/** The claim carries a code and a token; nothing near this. */
const CLAIM_BODY_MAX = 16 * 1024;
const encoder = new TextEncoder();

/** Whether two strings are equal, taking the same time whatever they hold: compares fixed-length digests. */
export async function sameCode(given: string, expected: string): Promise<boolean> {
  const [a, b] = await Promise.all([given, expected].map(async (t) => new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(t)))));
  if (a === undefined || b === undefined) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

async function sealingKey(secret: string, origin: string, usage: "encrypt" | "decrypt"): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey("raw", encoder.encode(secret), "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: encoder.encode("vemi setup claim"), info: encoder.encode(`token|${origin}`) },
    base, { name: "AES-GCM", length: 256 }, false, [usage],
  );
}

/** `v1.<iv>.<ciphertext>`, base64url. */
export async function sealToken(token: string, secret: string, origin: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await sealingKey(secret, origin, "encrypt");
  const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, encoder.encode(token)));
  return `v1.${toBase64Url(iv)}.${toBase64Url(sealed)}`;
}

/** The token a `sealToken` answer holds, or null when the secret or address is not the one it was sealed under. */
export async function openToken(sealed: string, secret: string, origin: string): Promise<string | null> {
  const [version, iv, body] = sealed.split(".");
  if (version !== "v1" || iv === undefined || body === undefined) return null;
  try {
    const key = await sealingKey(secret, origin, "decrypt");
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromBase64Url(iv) }, key, fromBase64Url(body));
    return new TextDecoder().decode(plain);
  } catch {
    return null;
  }
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", ...headers } });
}

export function createSetup(deps: SetupDeps): Setup {
  const { store } = deps;
  const refused = (headers: Record<string, string> = {}): Response => json(403, { error: "This copy cannot be set up that way." }, headers);

  /** CORS for the setup page only, and only while the copy is unclaimed. */
  async function cors(request: Request): Promise<Record<string, string>> {
    const asked = request.headers.get("origin");
    if (deps.from === "" || asked !== deps.from) return {};
    if ((await store.setupClaim()) !== null) return {};
    return {
      "access-control-allow-origin": deps.from,
      "access-control-allow-methods": "POST, OPTIONS",
      "access-control-allow-headers": "content-type",
      "access-control-max-age": "600",
      vary: "origin",
    };
  }

  const ownerExists = async (owner: string): Promise<boolean> => (await store.account(owner)) !== null;

  /**
   * A move into an account that exists, by the code that account made (`POST /api/move-code`).
   * Without `confirm` it only says what the file holds and what the account holds now. With
   * it, the code is spent and the account's stuff is replaced by the file's. The code names
   * the account, so it never reaches another.
   */
  async function accountMove(given: Record<string, unknown>, door: NonNullable<SetupDeps["move"]>, headers: Record<string, string>): Promise<Response> {
    const no = (): Response => refused(headers);
    if (typeof given.code !== "string" || given.code === "") return no();
    const id = await moveCodeId(given.code);
    const live = await store.pendingToken(id, "confirm");
    if (live === null || live.email !== MOVE_CODE_MARK) return no();

    const { code: _code, email, password, ...rest } = given;
    if (email !== undefined || password !== undefined) return json(400, { error: "A move code takes no email or password." }, headers);
    const asked = parseRestore(rest);
    if (!asked.ok) return json(400, { error: asked.error }, headers);
    const checked = await store.checkRestore(asked.value.file, live.owner);
    if (!checked.ok) return json(checked.status, { error: checked.error }, headers);

    if (!asked.value.confirmed) {
      const held = (await store.exportAll(live.owner, new Date())).tables;
      const holds = Object.fromEntries(Object.entries(held).map(([name, rows]) => [name, rows.length]));
      return json(200, { moved: false, counts: checked.value.counts, holds, confirm: "replace" }, headers);
    }
    // Spent before anything is written, so two at once cannot both land.
    const spent = await store.takeEmailToken(id, "confirm");
    if (spent === null || spent.email !== MOVE_CODE_MARK) return no();
    const done = await store.restoreAll(live.owner, asked.value.file);
    if (!done.ok) return json(done.status, { error: done.error }, headers);
    await door.publish(live.owner, { kind: "ventures", id: "restore", ventureId: null }).catch(() => {});
    return json(200, { counts: done.value.counts, locked: done.value.locked, ids: done.value.ids }, headers);
  }

  /**
   * `POST /setup/move`: on a copy with no owner, makes the owner account from an email and a
   * password and puts a file's rows in it, once, for whoever holds the copy's code. Only from
   * the origin the copy was built for; with an owner already there it changes nothing.
   */
  async function move(request: Request): Promise<Response> {
    const door = deps.move;
    const headers = moveCors(request.headers.get("origin"), deps.from);
    const no = (): Response => refused(headers);
    if (door === undefined || deps.from === "") return refused();
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });
    if (request.method !== "POST" || !sentJson(request) || headers["access-control-allow-origin"] === undefined) return no();

    const capped = await capBytes(request);
    if (!capped.ok) {
      const { status, statusText } = capped.response;
      return new Response(capped.response.body, { status, statusText, headers: { "content-type": "application/json; charset=utf-8", ...headers } });
    }
    let body: unknown;
    try {
      body = JSON.parse(capped.text);
    } catch {
      return no();
    }
    const given = typeof body === "object" && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
    // Not the copy's own code: it may be one an account made for itself.
    if (deps.secret === "" || !(await moveCodeOk(given.code, deps.secret))) return accountMove(given, door, headers);

    const { code: _code, email, password, ...rest } = given;
    const asked = parseRestore(rest);
    if (!asked.ok) return json(400, { error: asked.error }, headers);
    const checked = await store.checkRestore(asked.value.file);
    if (!checked.ok) return json(checked.status, { error: checked.error }, headers);

    if (await ownerExists(door.owner)) {
      // The copy has an owner: nothing is made or changed; what the file holds comes back.
      if (asked.value.confirmed) return json(409, { error: "This copy already has an owner." }, headers);
      return json(200, { moved: false, counts: checked.value.counts, confirm: "replace" }, headers);
    }
    if (typeof email !== "string" || typeof password !== "string") return json(400, { error: "Send an email address and a password." }, headers);

    const made = await door.identity.claimOwner(email, password);
    if ("refused" in made) return json(made.refused.status, { error: made.refused.error }, headers);
    const done = await store.restoreAll(door.owner, asked.value.file);
    // The account stays: the person signs in with the password they chose and moves again.
    if (!done.ok) return json(done.status, { error: "The copy was made but your stuff did not arrive. Sign in and move again." }, headers);
    await door.publish(door.owner, { kind: "ventures", id: "restore", ventureId: null }).catch(() => {});
    return json(200, { counts: done.value.counts, locked: done.value.locked, ids: done.value.ids, recoveryCode: made.recoveryCode, handOver: made.handOver }, headers);
  }

  return {
    async handle(request) {
      const path = new URL(request.url).pathname;
      if (path === MOVE_PATH) return move(request);
      if (path !== PATH || deps.secret === "") return null;
      const headers = await cors(request);
      if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });
      if (request.method !== "POST" || !sentJson(request)) return refused(headers);

      const capped = await capBody(request, CLAIM_BODY_MAX);
      if (!capped.ok) return refused(headers);
      let body: unknown;
      try {
        body = JSON.parse(capped.text);
      } catch {
        return refused(headers);
      }
      const given = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
      if (typeof given.code !== "string" || !(await sameCode(given.code, deps.secret))) return refused(headers);
      if ((await store.setupClaim()) !== null) return refused();

      const keep = given.keepUpdated === true;
      if (typeof given.keepUpdated !== "boolean") return json(400, { error: "Send keepUpdated as true or false." }, headers);
      if (keep && (typeof given.token !== "string" || given.token === "" || given.token.length > MAX_TOKEN)) {
        return json(400, { error: "Send the token to keep." }, headers);
      }
      const sealed = keep ? await sealToken(given.token as string, deps.secret, deps.origin) : null;
      const kept = await store.keepSetupClaim(sealed, keep);
      if (!kept.made) return refused();
      return json(200, { claimed: true }, headers);
    },
  };
}
