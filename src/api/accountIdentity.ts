/**
 * Accounts. An `Identity` that signs a person in by email and password, or with Google.
 * With `password.ts` and `google.ts`, the only code that knows how. No mail is sent: the owner
 * is handed an invite link and passes it on.
 *
 * - **The account id is the owner key.** A session names an account, and the account's id is
 *   the `owner` every row of that person's data carries. The operator is the account whose id
 *   is `OWNER`; there is no role column.
 * - **A session is a signed cookie**, HMAC-SHA256 under `SESSION_SECRET`, thirty days from last
 *   use: a request it signs with fewer than fifteen days left is answered with a fresh one at
 *   the same generation, so "sign out everywhere" still ends it. Its body is
 *   `<account id>\n<generation>\n<expires>`. `resolve` makes the one D1 read the
 *   application already paid for: `sessionHolds`, which says whether the generation is still
 *   current. `resolveRead` asks the same in the read's own first round trip instead, so a read
 *   costs one. A password change, a reset and "sign out everywhere" move the generation on, so
 *   every other device is refused at its next request while this one gets a fresh cookie.
 *   Sign out on one device clears its cookie and leaves a mark that refuses any session cookie
 *   until the next sign-in there, so a renewal that lands after it cannot sign the device back in.
 * - **Sign-up is closed.** An account is made from an invite, or by the first person to claim
 *   `OWNER` on a copy with no accounts: an email and a password (`/auth/claim`) or Google.
 *   With `OPERATOR_EMAIL` set, only that address can claim.
 * - **An invite or reset link is a token in the fragment.** 32 random bytes, stored only as a SHA-256,
 *   single use, bound to a purpose and expiring. The page posts it; no log sees it in a URL.
 * - **Failures are throttled in D1**, by SHA-256 keys, so no raw address or IP is kept. An
 *   attempt is counted before the work it guards and given back when it turns out good, so a
 *   burst sent all at once is held to the limit too. An IPv6 address counts by its /64. Every
 *   sign-in failure answers with the same sentence, so an address is never confirmed or denied.
 * - **Two-step is optional and the account's own.** The authenticator key is sealed with AES-GCM
 *   under a key derived from `SESSION_SECRET` (HKDF), so rotating that secret turns 2-step off
 *   for everyone. While it is on, sign-in asks for a code after the password: six digits from the
 *   app, or one of ten backup codes, each good once. A recovery code, shown once when an account
 *   is made, sets a new password without the old one and turns 2-step off; a person can make a new
 *   one, which replaces it. Every guess at a code is throttled like a password.
 * - **Everything fails closed.** Without an origin or `OWNER`, nothing resolves and the auth
 *   routes answer 503 naming what is unset. The session secret is never missing: with no
 *   `SESSION_SECRET` the copy makes its own on first use (see sessionKey.ts). Without Google its routes
 *   answer 503 in words anyone may read, and `describe` names what is unset. Password sign-in
 *   carries on.
 *
 * The Google callback sends the browser to `/` and hands a refusal over as `/#google=<code>`:
 * `unavailable`, `state`, `denied`, `failed`, `taken`, `invite`, `other` or `unknown`. A
 * sign-in that linked Google to the account at its address arrives as `/#google=linked`.
 */
import { capBody } from "./body.js";
import type { Identity, OwnerClaim, Resolution } from "./identity.js";
import { authUrl, challengeFor, exchange, newFlow } from "./google.js";
import { dummyVerify, hashPassword, needsRehash, passwordProblem, verifyPassword } from "./password.js";
import { MOVE_CODE_MARK, type AccountSecret, type AttemptLimit, type EmailToken, type SessionState, type Store, type TokenPurpose } from "./store.js";
import { base32Encode, hashCode, newCodes, newRecoveryCode, matchTotpStep, otpauthUri, verifyTotp } from "./totp.js";
import { sentJson } from "./validate.js";

export interface AccountConfig {
  readonly store: Store;
  readonly now: () => Date;
  /** `https://vemi.anvildynamics.com.au`. The Google redirect binds to it. */
  readonly origin: string;
  /** `OWNER`: the id the operator's account takes. */
  readonly owner: string;
  /** `OPERATOR_EMAIL`, a secret. Empty means the first sign-up claims `OWNER`; set, only that address can. */
  readonly operatorEmail: string;
  /** The signing secret, or a function that answers it (the one a copy makes for itself, from D1). */
  readonly sessionSecret: string | (() => Promise<string>);
  /** Whether a `SETUP_CLAIM` secret is set: then the first sign-up waits until the setup page has taken the code. */
  readonly setupClaim?: boolean;
  readonly google: { readonly clientId: string; readonly clientSecret: string } | null;
  readonly fetch: typeof fetch;
}

const COOKIE = "__Host-vemi";
const GOOGLE_COOKIE = "__Host-vemi-google";
/** Set by Sign out on this device; while it is there, no session cookie signs anything. */
const OUT_COOKIE = "__Host-vemi-out";
const SESSION_SECONDS = 30 * 24 * 60 * 60;
/** A session with less than this left is renewed by the next request it signs. */
const RENEW_SECONDS = 15 * 24 * 60 * 60;
const GOOGLE_SECONDS = 10 * 60;

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const LIFETIME: Readonly<Record<TokenPurpose, number>> = { invite: 7 * DAY, confirm: DAY, reset: HOUR };
/** A reset link the owner makes for one of their people has a day, for the owner to pass on. */
const RESET_BY_OWNER = DAY;
/** The hand-over a move makes lives five minutes and opens once. */
const MOVE_IN_LIFETIME = 5 * MINUTE;
const moveInPage = (to: string): string =>
  '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
  `<meta http-equiv="refresh" content="0;url=${to}"><title>VEMI</title></head><body></body></html>`;
const MOVE_IN_PAGE = moveInPage("/");
/** Where a move that carried locked content lands: the app reads the mark and starts the finishing pass. */
const MOVE_IN_FINISHING_PAGE = moveInPage("/?finishing=1");

const SIGN_IN_WINDOW = 15 * MINUTE;
const SIGN_IN_PER_EMAIL = 5;
const SIGN_IN_PER_IP = 30;
const INVITE_WINDOW = HOUR;
const INVITE_PER_ADDRESS = 3;
const INVITE_PER_IP = 10;
// Every throttle row is swept past the longest window, so one sweep serves every kind.
const SWEEP = HOUR;
/** The most an auth write may carry. */
const AUTH_BODY_MAX = 64 * 1024;

/** A window in words, so a refusal can say how long to wait. */
const waitWords = (ms: number): string =>
  ms === HOUR ? "an hour" : ms % HOUR === 0 ? `${ms / HOUR} hours` : `${Math.round(ms / MINUTE)} minutes`;

// What a person reads on the card or in the account panel: whole sentences. The rest of the
// Worker's refusals are for whoever calls the API, and stay terse.
const NO_MATCH = "That email and password don't match.";
const TOO_MANY_TRIES = `Too many tries. Wait ${waitWords(SIGN_IN_WINDOW)} and try again.`;
const TOO_MANY_INVITES = `Too many invites made. Wait ${waitWords(INVITE_WINDOW)} and try again.`;
const BAD_LINK = "That link has expired or was already used. Ask for a new one.";
const GONE = "This account no longer exists.";
const NEED_CODE = "Enter the code from your authenticator app, or a backup code.";
const NO_CODE_MATCH = "That code doesn't work.";
const NO_RECOVERY_MATCH = "That email and recovery code don't match.";
const BACKUP_COUNT = 10;

const utf8 = new TextEncoder();

export function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export function fromBase64Url(text: string): Uint8Array<ArrayBuffer> {
  const binary = atob(text.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat((4 - (text.length % 4)) % 4));
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

export function readCookie(request: Request, name: string): string | null {
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=");
  }
  return null;
}

function json(status: number, body: unknown, cookies: readonly string[] = []): Response {
  const headers = new Headers({ "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  for (const cookie of cookies) headers.append("set-cookie", cookie);
  return new Response(JSON.stringify(body), { status, headers });
}

function redirect(location: string, cookies: readonly string[]): Response {
  const headers = new Headers({ location, "cache-control": "no-store" });
  for (const cookie of cookies) headers.append("set-cookie", cookie);
  return new Response(null, { status: 302, headers });
}

async function sha256Hex(text: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", utf8.encode(text)));
  return Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Equal length first, then a comparison that does not stop at the first difference. */
function sameText(a: string, b: string): boolean {
  const x = utf8.encode(a);
  const y = utf8.encode(b);
  if (x.byteLength !== y.byteLength) return false;
  let diff = 0;
  for (let i = 0; i < x.byteLength; i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

/**
 * The network a request comes from, as the throttle counts it. An IPv4 address is one
 * subscriber. An IPv6 subscriber is handed a whole /64 and can move about inside it, so an
 * IPv6 address counts by its first four groups. One that carries an IPv4 address in its tail
 * (`::ffff:203.0.113.5`, `64:ff9b::203.0.113.5`) is that IPv4 subscriber: its first four
 * groups are the same for everyone, so counting by them would put every such client in one.
 */
export function networkOf(ip: string): string {
  const embedded = /(?:\d{1,3}\.){3}\d{1,3}$/.exec(ip);
  if (embedded !== null) return embedded[0];
  if (!ip.includes(":")) return ip;
  const halves = ip.toLowerCase().split("::");
  if (halves.length > 2) return ip;
  const [left = "", right = ""] = halves;
  const head = left === "" ? [] : left.split(":");
  const tail = right === "" ? [] : right.split(":");
  const groups = halves.length === 2 ? [...head, ...Array<string>(Math.max(0, 8 - head.length - tail.length)).fill("0"), ...tail] : head;
  return `${groups.slice(0, 4).map((g) => g.replace(/^0+(?=.)/, "")).join(":")}::/64`;
}

const normalEmail = (value: unknown): string => (typeof value === "string" ? value.trim().toLowerCase() : "");
/** An address has a part either side of one @, and runs to 254 characters at most (RFC 5321). */
const looksLikeEmail = (email: string): boolean => email.length <= 254 && /^[^\s@]+@[^\s@]+$/.test(email);

interface Session {
  readonly id: string;
  readonly generation: number;
  /** When the cookie stops being accepted, in seconds since the epoch. */
  readonly expires: number;
}

interface GoogleState {
  readonly state: string;
  readonly verifier: string;
  readonly nonce: string;
  readonly intent: "sign-in" | "link" | "invite";
  readonly owner?: string;
  readonly token?: string;
  readonly expires: number;
}

export function accountIdentity(config: AccountConfig): Identity {
  const { store, google } = config;
  const owner = config.owner.trim();
  const operatorEmail = normalEmail(config.operatorEmail);

  const missing: string[] = [];
  try {
    new URL(config.origin);
  } catch {
    missing.push("ORIGIN");
  }
  if (owner === "") missing.push("OWNER");

  const unset = [...missing];
  if (google === null) unset.push("Google (GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET)");
  const describe = `email and password, and Google${unset.length > 0 ? `; unset: ${unset.join(", ")}` : ""}`;

  const signInTooMany = TOO_MANY_TRIES;

  const secretText = (): Promise<string> =>
    typeof config.sessionSecret === "string" ? Promise.resolve(config.sessionSecret) : config.sessionSecret();

  let key: Promise<CryptoKey> | null = null;
  const hmacKey = (): Promise<CryptoKey> => {
    key ??= secretText().then((secret) =>
      crypto.subtle.importKey("raw", utf8.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]),
    ).catch((error: unknown) => {
      key = null;
      throw error;
    });
    return key;
  };

  /** AES-GCM key for the authenticator secret, derived from SESSION_SECRET so nothing else is kept. */
  let sealKey: Promise<CryptoKey> | null = null;
  const aesKey = (): Promise<CryptoKey> => {
    sealKey ??= secretText().then((secret) => crypto.subtle.importKey("raw", utf8.encode(secret), "HKDF", false, ["deriveKey"])).then((base) =>
      crypto.subtle.deriveKey(
        { name: "HKDF", hash: "SHA-256", salt: utf8.encode("vemi-two-step"), info: utf8.encode("authenticator secret") },
        base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"],
      )).catch((error: unknown) => {
      sealKey = null;
      throw error;
    });
    return sealKey;
  };

  async function seal(secret: Uint8Array<ArrayBuffer>): Promise<string> {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await aesKey(), secret));
    const out = new Uint8Array(iv.length + sealed.length);
    out.set(iv);
    out.set(sealed, iv.length);
    return toBase64Url(out);
  }

  /** The key a sealed value holds, or null when it was sealed under another SESSION_SECRET or is damaged. */
  async function unseal(value: string | null): Promise<Uint8Array | null> {
    if (value === null) return null;
    try {
      const bytes = fromBase64Url(value);
      return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: bytes.slice(0, 12) }, await aesKey(), bytes.slice(12)));
    } catch {
      return null;
    }
  }

  async function sign(body: string): Promise<string> {
    const signature = new Uint8Array(await crypto.subtle.sign("HMAC", await hmacKey(), utf8.encode(body)));
    return `${toBase64Url(utf8.encode(body))}.${toBase64Url(signature)}`;
  }

  /** The text inside a signed value, or null when it was not signed by us. `crypto.subtle.verify` compares in constant time. */
  async function unsign(value: string | null): Promise<string | null> {
    const [body, signature, extra] = value?.split(".") ?? [];
    if (!body || !signature || extra !== undefined) return null;
    try {
      const valid = await crypto.subtle.verify("HMAC", await hmacKey(), fromBase64Url(signature), utf8.encode(new TextDecoder().decode(fromBase64Url(body))));
      return valid ? new TextDecoder().decode(fromBase64Url(body)) : null;
    } catch {
      return null;
    }
  }

  const nowMs = (): number => config.now().getTime();
  const later = (ms: number): string => new Date(nowMs() + ms).toISOString();
  const earlier = (ms: number): string => new Date(nowMs() - ms).toISOString();

  async function sessionCookie(id: string, generation: number): Promise<string> {
    const expires = Math.floor(nowMs() / 1000) + SESSION_SECONDS;
    return `${COOKIE}=${await sign(`${id}\n${generation}\n${expires}`)}; Path=/; Max-Age=${SESSION_SECONDS}; HttpOnly; Secure; SameSite=Strict`;
  }
  const clearedSession = `${COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict`;
  // Lax, because the callback is a cross-site top-level navigation from Google; Strict cookies are not sent on it.
  const clearedGoogle = `${GOOGLE_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;
  // Sign-out leaves this behind, as long as any session could last. A read still in flight
  // when the person signs out can come back after the sign-out with a renewed session cookie,
  // and nothing orders the two; the renewal never touches this, so the device stays out.
  const signedOutMark = `${OUT_COOKIE}=1; Path=/; Max-Age=${SESSION_SECONDS}; HttpOnly; Secure; SameSite=Strict`;
  const clearedMark = `${OUT_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict`;

  /** A session a person asked for, which lifts the sign-out mark. A renewal does not. */
  async function signedInCookies(id: string, generation: number): Promise<string[]> {
    return [await sessionCookie(id, generation), clearedMark];
  }

  async function readSession(request: Request): Promise<Session | null> {
    if ((readCookie(request, OUT_COOKIE) ?? "") !== "") return null;
    const text = await unsign(readCookie(request, COOKIE));
    if (text === null) return null;
    const [id, generation, expires] = text.split("\n");
    if (!id || !/^\d+$/.test(generation ?? "") || !/^\d+$/.test(expires ?? "")) return null;
    if (Number(expires) * 1000 <= nowMs()) return null;
    return { id, generation: Number(generation), expires: Number(expires) };
  }

  type Held = { readonly session: Session } | { readonly refused: string };

  /** The session a request's cookie signs, before asking D1 whether it still stands. */
  async function signed(request: Request): Promise<Held> {
    if (missing.length > 0) return { refused: `not configured: ${missing.join(", ")} unset` };
    const session = await readSession(request);
    return session === null ? { refused: "Sign in first." } : { session };
  }

  function standing(session: Session, state: SessionState): Held {
    if (state === "ended") return { refused: "Signed out everywhere. Sign in again." };
    if (state === "gone") return { refused: GONE };
    return { session };
  }

  async function hold(request: Request): Promise<Held> {
    const held = await signed(request);
    if ("refused" in held) return held;
    return standing(held.session, await store.sessionHolds(held.session.id, held.session.generation));
  }

  /** The owner a held session names, and a fresh cookie when this one is wearing out. */
  async function resolution({ id, generation, expires }: Session): Promise<{ owner: string; renew?: string }> {
    if (expires - nowMs() / 1000 >= RENEW_SECONDS) return { owner: id };
    return { owner: id, renew: await sessionCookie(id, generation) };
  }

  async function keyOf(kind: string, value: string): Promise<string> {
    return sha256Hex(`vemi-throttle:${kind}:${value}`);
  }

  const ipOf = (request: Request): string => networkOf(request.headers.get("cf-connecting-ip") ?? "unknown");

  /** Counts this attempt against every key, unless one is at its limit: then null, and nothing is counted. */
  const reserve = (email: string | null, limits: readonly AttemptLimit[], window: number) =>
    store.attempt(email, limits, config.now().toISOString(), earlier(window), earlier(SWEEP));

  async function newToken(
    purpose: TokenPurpose, ownerId: string, email: string, lifetime: number = LIFETIME[purpose],
  ): Promise<{ token: string; row: EmailToken }> {
    const token = toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
    return {
      token,
      row: { id: await sha256Hex(token), owner: ownerId, purpose, email, expiresAt: later(lifetime) },
    };
  }

  async function takeToken(token: unknown, purpose: TokenPurpose): Promise<EmailToken | null> {
    if (typeof token !== "string" || token === "") return null;
    return store.takeEmailToken(await sha256Hex(token), purpose);
  }

  const link = (page: string, token: string): string => `${config.origin}/${page}#${token}`;

  /** Every dead link gets the same answer, with a code the page reads instead of the sentence. */
  const badLink = (): Response => json(400, { error: BAD_LINK, code: "link" });

  /**
   * The address a link was made for, without spending it, so the page can say whose
   * account the new password is for, a password manager can file it, and a dead link says so
   * before anyone types. Only the link's holder can ask. Not
   * throttled: like the invite check in `acceptInvite`, a 32-byte token cannot be guessed.
   */
  async function linkFor(body: Record<string, unknown>): Promise<Response> {
    const purpose = body.purpose;
    if (purpose !== "reset" && purpose !== "invite") return json(400, { error: "purpose is reset or invite" });
    if (typeof body.token !== "string" || body.token === "") return badLink();
    const hashed = await sha256Hex(body.token);
    if (purpose === "invite") {
      // An invitation by first name has no address yet; the page says whose it is.
      const named = await store.pendingPersonInvite(hashed);
      if (named !== null) return json(200, { firstName: named.firstName });
    }
    const token = await store.pendingToken(hashed, purpose);
    return token === null ? badLink() : json(200, { email: token.email });
  }

  /**
   * True while the copy has no owner account: the first sign-up makes it. A copy set up with
   * `SETUP_CLAIM` waits until the setup page has used the code once.
   */
  async function claimable(): Promise<boolean> {
    if ((await store.account(owner)) !== null) return false;
    return !config.setupClaim || (await store.setupClaim()) !== null;
  }

  async function me(request: Request): Promise<Response> {
    const base = { googleReady: google !== null };
    const out = async (): Promise<Response> => json(200, { signedIn: false, ...base, claimable: await claimable() });
    const held = await hold(request);
    if ("refused" in held) return out();
    const account = await store.account(held.session.id);
    if (account === null) return out();
    return json(200, {
      signedIn: true,
      id: account.id,
      email: account.email,
      operator: account.id === owner,
      password: account.passwordHash !== null,
      google: account.googleSub !== null,
      firstName: account.firstName,
      twoStep: account.twoStepOnAt !== null,
      deleteOn: account.deleteOn,
      ...base,
    });
  }

  async function signIn(request: Request, body: Record<string, unknown>): Promise<Response> {
    const email = normalEmail(body.email);
    const password = typeof body.password === "string" ? body.password : "";
    const byEmail = await keyOf("in-email", email);
    const { account, reserved } = await reserve(email, [
      { key: byEmail, limit: SIGN_IN_PER_EMAIL },
      { key: await keyOf("in-ip", ipOf(request)), limit: SIGN_IN_PER_IP },
    ], SIGN_IN_WINDOW);
    if (reserved === null) return json(429, { error: signInTooMany });

    // A missing account, a Google-only account and a wrong password all do the same work.
    // A failure leaves the rows it reserved standing: they are the count.
    const matched = account?.passwordHash ? await verifyPassword(password, account.passwordHash) : await dummyVerify(password);
    if (!matched || account === null || account.passwordHash === null || !account.confirmed) {
      return json(401, { error: NO_MATCH });
    }

    if (account.twoStepOnAt !== null) {
      const code = typeof body.code === "string" ? body.code.trim() : "";
      if (code === "") {
        // The password was right, so asking for the next step counts nothing; the code is what is counted.
        await store.forgetAttempts([], reserved);
        return json(401, { error: NEED_CODE, code: "two-step" });
      }
      if (!(await codeWorks(account, code))) return json(401, { error: NO_CODE_MATCH, code: "two-step" });
    }

    // The right password clears the address's failures and gives back its place against the network.
    await store.forgetAttempts([byEmail], reserved);
    let generation = account.generation;
    if (needsRehash(account.passwordHash)) {
      // The store has one way to set a hash and it ends other sessions. A raised iteration count is rare, so it costs once.
      generation = (await store.setPassword(account.id, await hashPassword(password), false)) ?? generation;
    }
    return json(200, { signedIn: true }, await signedInCookies(account.id, generation));
  }

  /** Six digits from the app, or a backup code, which is used up. A key sealed under another SESSION_SECRET never matches. */
  async function codeWorks(account: AccountSecret, code: string): Promise<boolean> {
    if (/^\d{3}\s?\d{3}$/.test(code)) {
      const secret = await unseal(account.twoStepSecret);
      if (secret === null) return false;
      const step = await matchTotpStep(secret, code, nowMs());
      // A step at or before the last one used is a replay; the store refuses it atomically too.
      if (step === null || (account.totpLastStep !== null && step <= account.totpLastStep)) return false;
      return store.acceptTotpStep(account.id, step);
    }
    return store.spendBackupCode(account.id, await hashCode(code));
  }

  /** Counts a guess against the account and the network, like a password change. Null when over the limit. */
  async function guess(accountId: string, request: Request): Promise<{ key: string; reserved: readonly number[] } | null> {
    const key = await keyOf("in-email", accountId);
    const { reserved } = await reserve(null, [
      { key, limit: SIGN_IN_PER_EMAIL },
      { key: await keyOf("in-ip", ipOf(request)), limit: SIGN_IN_PER_IP },
    ], SIGN_IN_WINDOW);
    return reserved === null ? null : { key, reserved };
  }

  /** A signed-in request whose body proves the account's password. */
  async function signedInWithPassword(request: Request, body: Record<string, unknown>): Promise<Response | AccountSecret> {
    const held = await hold(request);
    if ("refused" in held) return json(401, { error: held.refused });
    const account = await store.account(held.session.id);
    if (account === null) return json(401, { error: GONE });
    if (account.passwordHash === null) return json(409, { error: "Set a password first." });
    const counted = await guess(account.id, request);
    if (counted === null) return json(429, { error: TOO_MANY_TRIES });
    const given = typeof body.password === "string" ? body.password : "";
    if (given === "" || !(await verifyPassword(given, account.passwordHash))) {
      return json(403, { error: "That isn't your password." });
    }
    await store.forgetAttempts([counted.key], counted.reserved);
    return account;
  }

  /** Begins setup: a fresh key, sealed and kept, not yet asked for at sign-in. Starting again replaces an unfinished one. */
  async function twoStepSetup(request: Request): Promise<Response> {
    const held = await hold(request);
    if ("refused" in held) return json(401, { error: held.refused });
    const account = await store.account(held.session.id);
    if (account === null) return json(401, { error: GONE });
    if (account.twoStepOnAt !== null) return json(409, { error: "2-step is already on." });
    const secret = crypto.getRandomValues(new Uint8Array(20));
    if (!(await store.setTwoStep(account.id, { secret: await seal(secret), on: false, backupCodes: [] }))) return json(401, { error: GONE });
    return json(200, { secret: base32Encode(secret), uri: otpauthUri(account.email, secret) });
  }

  /** The first good code turns 2-step on and hands over the backup codes, once. */
  async function twoStepVerify(request: Request, body: Record<string, unknown>): Promise<Response> {
    const held = await hold(request);
    if ("refused" in held) return json(401, { error: held.refused });
    const account = await store.account(held.session.id);
    if (account === null) return json(401, { error: GONE });
    if (account.twoStepOnAt !== null) return json(409, { error: "2-step is already on." });
    const secret = await unseal(account.twoStepSecret);
    if (secret === null) return json(409, { error: "Start setup first." });
    const counted = await guess(account.id, request);
    if (counted === null) return json(429, { error: TOO_MANY_TRIES });
    if (typeof body.code !== "string" || !(await verifyTotp(secret, body.code, nowMs()))) return json(400, { error: NO_CODE_MATCH });
    await store.forgetAttempts([counted.key], counted.reserved);
    const codes = await newCodes(BACKUP_COUNT);
    await store.setTwoStep(account.id, { secret: account.twoStepSecret, on: true, backupCodes: codes.map((c) => c.hash) });
    return json(200, { ok: true, backupCodes: codes.map((c) => c.code) });
  }

  async function twoStepOff(request: Request, body: Record<string, unknown>): Promise<Response> {
    const who = await signedInWithPassword(request, body);
    if (who instanceof Response) return who;
    await store.setTwoStep(who.id, { secret: null, on: false, backupCodes: [] });
    return json(200, { ok: true });
  }

  /** A new recovery code for a signed-in person who proves their password. It replaces the old one, which stops working. */
  async function recoveryNew(request: Request, body: Record<string, unknown>): Promise<Response> {
    const who = await signedInWithPassword(request, body);
    if (who instanceof Response) return who;
    const fresh = await newRecoveryCode();
    await store.setRecoveryCode(who.id, fresh.hash);
    return json(200, { recoveryCode: fresh.code });
  }

  /**
   * Sets a new password from the recovery code, without the old one. The code is spent, 2-step
   * is turned off (the code is the way back in without the app), every other session ends and a
   * new recovery code comes back once. Every miss answers the same words and is counted.
   */
  async function recover(request: Request, body: Record<string, unknown>): Promise<Response> {
    const email = normalEmail(body.email);
    const byEmail = await keyOf("in-email", email);
    const { account, reserved } = await reserve(email, [
      { key: byEmail, limit: SIGN_IN_PER_EMAIL },
      { key: await keyOf("in-ip", ipOf(request)), limit: SIGN_IN_PER_IP },
    ], SIGN_IN_WINDOW);
    if (reserved === null) return json(429, { error: TOO_MANY_TRIES });
    const problem = typeof body.password === "string" ? passwordProblem(body.password) : "Send the new password.";
    if (problem !== null) return json(400, { error: problem });
    const given = typeof body.recoveryCode === "string" ? body.recoveryCode.trim() : "";
    if (account === null || given === "" || !(await store.spendRecoveryCode(account.id, await hashCode(given)))) {
      return json(401, { error: NO_RECOVERY_MATCH });
    }
    await store.forgetAttempts([byEmail], reserved);
    const generation = await store.setPassword(account.id, await hashPassword(body.password as string), true);
    if (generation === null) return json(401, { error: NO_RECOVERY_MATCH });
    await store.setTwoStep(account.id, { secret: null, on: false, backupCodes: [] });
    const fresh = await newRecoveryCode();
    await store.setRecoveryCode(account.id, fresh.hash);
    return json(200, { signedIn: true, recoveryCode: fresh.code }, await signedInCookies(account.id, generation));
  }

  async function changePassword(request: Request, body: Record<string, unknown>): Promise<Response> {
    const held = await hold(request);
    if ("refused" in held) return json(401, { error: held.refused });
    const account = await store.account(held.session.id);
    if (account === null) return json(401, { error: GONE });

    const problem = typeof body.next === "string" ? passwordProblem(body.next) : "Send the new password.";
    if (problem !== null) return json(400, { error: problem });
    if (account.passwordHash !== null) {
      // Knowing the current password is the proof, so guessing it is throttled like signing in.
      const byAccount = await keyOf("in-email", held.session.id);
      const { reserved } = await reserve(null, [
        { key: byAccount, limit: SIGN_IN_PER_EMAIL },
        { key: await keyOf("in-ip", ipOf(request)), limit: SIGN_IN_PER_IP },
      ], SIGN_IN_WINDOW);
      if (reserved === null) return json(429, { error: TOO_MANY_TRIES });
      const current = typeof body.current === "string" ? body.current : "";
      if (current === "" || !(await verifyPassword(current, account.passwordHash))) {
        return json(403, { error: "That isn't your current password." });
      }
      await store.forgetAttempts([byAccount], reserved);
    }
    const generation = await store.setPassword(account.id, await hashPassword(body.next as string), false);
    if (generation === null) return json(401, { error: GONE });
    return json(200, { ok: true }, await signedInCookies(account.id, generation));
  }

  async function signOutEverywhere(request: Request): Promise<Response> {
    const held = await hold(request);
    if ("refused" in held) return json(401, { error: held.refused });
    const generation = await store.endSessions(held.session.id);
    if (generation === null) return json(401, { error: GONE });
    return json(200, { ok: true }, await signedInCookies(held.session.id, generation));
  }

  /** Invites are counted per address and per network: each one made is a row against both. */
  async function inviteLimits(request: Request, email: string): Promise<AttemptLimit[]> {
    return [
      { key: await keyOf("mail-email", email), limit: INVITE_PER_ADDRESS },
      { key: await keyOf("mail-ip", ipOf(request)), limit: INVITE_PER_IP },
    ];
  }

  async function reset(body: Record<string, unknown>): Promise<Response> {
    const problem = typeof body.password === "string" ? passwordProblem(body.password) : "Send the new password.";
    if (problem !== null) return json(400, { error: problem });
    const token = await takeToken(body.token, "reset");
    if (token === null) return badLink();
    const account = await store.account(token.owner);
    if (account === null || account.email !== token.email) return badLink();
    // A reset link is the owner's word for the address, so it confirms it and ends every other session.
    const generation = await store.setPassword(account.id, await hashPassword(body.password as string), true);
    if (generation === null) return badLink();
    return json(200, { signedIn: true }, await signedInCookies(account.id, generation));
  }

  /**
   * Makes the `OWNER` account on a fresh copy: the email and password sent, while no owner
   * account exists. Whoever reaches a copy first claims it (decision 28), unless `OPERATOR_EMAIL`
   * is set, and then only that address can. Once it exists this refuses for good.
   */
  async function makeOwner(
    rawEmail: unknown, password: unknown,
  ): Promise<{ readonly recoveryCode: string; readonly email: string } | { readonly refused: { readonly status: number; readonly error: string } }> {
    const refuse = (status: number, error: string) => ({ refused: { status, error } });
    const email = normalEmail(rawEmail);
    if (!looksLikeEmail(email)) return refuse(400, "Send an email address.");
    if (operatorEmail !== "" && email !== operatorEmail) return refuse(403, "That address cannot claim this copy.");
    const problem = typeof password === "string" ? passwordProblem(password) : "Send the new password.";
    if (problem !== null) return refuse(400, problem);
    const made = await store.createAccount({
      id: owner, email, passwordHash: await hashPassword(password as string), googleSub: null, confirmed: true,
    });
    if (!made) return refuse(409, "This copy already has an owner.");
    const recovery = await newRecoveryCode();
    await store.setRecoveryCode(owner, recovery.hash);
    return { recoveryCode: recovery.code, email };
  }

  async function claim(body: Record<string, unknown>): Promise<Response> {
    if (!(await claimable())) return json(409, { error: "This copy already has an owner." });
    const made = await makeOwner(body.email, body.password);
    if ("refused" in made) return json(made.refused.status, { error: made.refused.error });
    return json(200, { signedIn: true, recoveryCode: made.recoveryCode }, await signedInCookies(owner, 0));
  }

  /** The move door has the copy's own code, so the setup claim is not asked for; an owner already there still refuses. */
  async function claimOwner(email: string, password: string): Promise<OwnerClaim> {
    const made = await makeOwner(email, password);
    if ("refused" in made) return made;
    const { token, row } = await newToken("confirm", owner, made.email, MOVE_IN_LIFETIME);
    await store.putEmailToken(row);
    return { recoveryCode: made.recoveryCode, handOver: token };
  }

  /**
   * Where the page that moved a person lands them: the hand-over is spent once, the session
   * cookies are set, and the page moves on by meta refresh. There is no Location header on
   * purpose: a redirect chain that began on another site would drop a SameSite=Strict cookie.
   */
  async function moveIn(url: URL): Promise<Response> {
    const given = url.searchParams.get("t");
    // A move code is a `confirm` row too, and it only lets a file replace the account's data. It never signs anyone in,
    // so it is looked at before anything is spent and stays usable.
    if (typeof given !== "string" || given === "") return badLink();
    const pending = await store.pendingToken(await sha256Hex(given), "confirm");
    if (pending === null || pending.email === MOVE_CODE_MARK) return badLink();
    const taken = await takeToken(given, "confirm");
    if (taken === null || taken.owner !== owner || taken.email === MOVE_CODE_MARK) return badLink();
    const account = await store.account(owner);
    if (account === null) return badLink();
    const headers = new Headers({
      "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "referrer-policy": "no-referrer",
    });
    for (const cookie of await signedInCookies(owner, account.generation)) headers.append("set-cookie", cookie);
    return new Response(url.searchParams.get("finish") === "1" ? MOVE_IN_FINISHING_PAGE : MOVE_IN_PAGE, { status: 200, headers });
  }

  async function operatorOnly(request: Request, refusal = "Only the operator can invite."): Promise<Response | Session> {
    const held = await hold(request);
    if ("refused" in held) return json(401, { error: held.refused });
    if (held.session.id !== owner) return json(403, { error: refusal });
    return held.session;
  }

  const ownerOnly = (request: Request) => operatorOnly(request, "Only the owner can do this.");

  const FIRST_NAME_MAX = 60;

  /** The owner names a person and gets a link to pass on. Nothing is sent. */
  async function inviteByName(request: Request, body: Record<string, unknown>): Promise<Response> {
    const who = await ownerOnly(request);
    if (who instanceof Response) return who;
    const firstName = typeof body.firstName === "string" ? body.firstName.trim() : "";
    if (firstName === "" || firstName.length > FIRST_NAME_MAX || /\p{Cc}/u.test(firstName)) {
      return json(400, { error: `Send a first name of up to ${FIRST_NAME_MAX} letters.` });
    }
    const { token, row } = await newToken("invite", who.id, "");
    await store.putInvite({ id: row.id, owner: who.id, firstName, expiresAt: row.expiresAt });
    return json(200, { ok: true, link: link("invite", token), expiresAt: row.expiresAt });
  }

  async function people(request: Request): Promise<Response> {
    const who = await ownerOnly(request);
    if (who instanceof Response) return who;
    return json(200, await store.people(who.id));
  }

  const idOf = (body: Record<string, unknown>): string | null => (typeof body.id === "string" && body.id !== "" ? body.id : null);

  async function withdrawPerson(request: Request, body: Record<string, unknown>): Promise<Response> {
    const who = await ownerOnly(request);
    if (who instanceof Response) return who;
    const id = idOf(body);
    if (id === null) return json(400, { error: "Send the invite's id." });
    if (!(await store.withdrawPersonInvite(who.id, id))) return json(404, { error: "No invite is waiting under that id." });
    return json(200, { ok: true });
  }

  /** The person goes the way they could send themselves: their deletion is scheduled, seven days out. */
  async function removePerson(request: Request, body: Record<string, unknown>): Promise<Response> {
    const who = await ownerOnly(request);
    if (who instanceof Response) return who;
    const id = idOf(body);
    if (id === null) return json(400, { error: "Send the person's id." });
    const result = await store.removePerson(who.id, id);
    return result.ok ? json(200, { ok: true, deleteOn: result.value.deleteOn }) : json(result.status, { error: result.error });
  }

  /** A link that sets a new password for one of the owner's people, good for a day. Nothing is sent. */
  async function resetPerson(request: Request, body: Record<string, unknown>): Promise<Response> {
    const who = await ownerOnly(request);
    if (who instanceof Response) return who;
    const id = idOf(body);
    if (id === null) return json(400, { error: "Send the person's id." });
    const person = (await store.people(who.id)).people.find((p) => p.id === id);
    if (person === undefined) return json(404, { error: "no such person" });
    const { token, row } = await newToken("reset", person.id, person.email, RESET_BY_OWNER);
    await store.putEmailToken(row);
    return json(200, { ok: true, link: link("reset", token), expiresAt: row.expiresAt });
  }

  async function invite(request: Request, body: Record<string, unknown>): Promise<Response> {
    const who = await operatorOnly(request);
    if (who instanceof Response) return who;
    const email = normalEmail(body.email);
    if (!looksLikeEmail(email)) return json(400, { error: "Send an email address." });
    if (email === operatorEmail) return json(409, { error: "That's your own address." });

    const { account, reserved } = await reserve(email, await inviteLimits(request, email), INVITE_WINDOW);
    if (account !== null) {
      // No invite is made, so nothing is counted.
      await store.forgetAttempts([], reserved ?? []);
      return json(409, { error: "That address already has an account." });
    }
    if (reserved === null) return json(429, { error: TOO_MANY_INVITES });

    const { token, row } = await newToken("invite", who.id, email);
    await store.putEmailToken(row);
    return json(200, { ok: true, link: link("invite", token) });
  }

  /** Withdraws a waiting invitation, so a mistyped or wrong address cannot open an account. */
  async function withdrawInvite(request: Request, body: Record<string, unknown>): Promise<Response> {
    const who = await operatorOnly(request);
    if (who instanceof Response) return who;
    const email = normalEmail(body.email);
    if (!looksLikeEmail(email)) return json(400, { error: "Send an email address." });
    if (!(await store.withdrawInvite(who.id, email))) return json(404, { error: "No invite is waiting for that address." });
    return json(200, { ok: true });
  }

  async function invites(request: Request): Promise<Response> {
    const who = await operatorOnly(request);
    if (who instanceof Response) return who;
    const pending = await store.invites(who.id);
    return json(200, { invites: pending.map((p) => ({ email: p.email, expiresAt: p.expiresAt })) });
  }

  /** An invitation by first name: the person types the address they will sign in with, and a password. */
  async function acceptByName(hashed: string, body: Record<string, unknown>): Promise<Response> {
    const email = normalEmail(body.email);
    if (!looksLikeEmail(email)) return json(400, { error: "Send an email address." });
    const id = crypto.randomUUID();
    const accepted = await store.acceptPersonInvite(hashed, { id, email, passwordHash: await hashPassword(body.password as string), googleSub: null });
    if (!accepted.made) {
      return accepted.why === "taken" ? json(409, { error: "That address already has an account." }) : badLink();
    }
    const recovery = await newRecoveryCode();
    await store.setRecoveryCode(id, recovery.hash);
    return json(200, { signedIn: true, recoveryCode: recovery.code }, await signedInCookies(id, 0));
  }

  async function acceptInvite(body: Record<string, unknown>): Promise<Response> {
    const problem = typeof body.password === "string" ? passwordProblem(body.password) : "Send the new password.";
    if (problem !== null) return json(400, { error: problem });
    if (typeof body.token !== "string" || body.token === "") return badLink();
    const hashed = await sha256Hex(body.token);
    // Looked at first, so a made-up link costs no password hash.
    if ((await store.pendingPersonInvite(hashed)) !== null) return acceptByName(hashed, body);
    if ((await store.pendingToken(hashed, "invite")) === null) return badLink();
    // The owner chose the address and handed over the link, so the account starts confirmed.
    const id = crypto.randomUUID();
    const accepted = await store.acceptInvite(hashed, { id, passwordHash: await hashPassword(body.password as string), googleSub: null });
    if (!accepted.made) {
      return accepted.why === "taken" ? json(409, { error: "That address already has an account." }) : badLink();
    }
    const recovery = await newRecoveryCode();
    await store.setRecoveryCode(id, recovery.hash);
    return json(200, { signedIn: true, recoveryCode: recovery.code }, await signedInCookies(id, 0));
  }

  const redirectUri = `${config.origin}/auth/google/callback`;

  async function googleStart(request: Request, body: Record<string, unknown>): Promise<Response> {
    if (google === null) return json(503, { error: "Google sign-in is not set up here." });
    const intent = body.intent;
    if (intent !== "sign-in" && intent !== "link" && intent !== "invite") return json(400, { error: "intent is sign-in, link or invite" });
    let linking: string | undefined;
    if (intent === "link") {
      const held = await hold(request);
      if ("refused" in held) return json(401, { error: held.refused });
      linking = held.session.id;
    }
    if (intent === "invite" && (typeof body.token !== "string" || body.token === "")) {
      return json(400, { error: "Send the invite token." });
    }
    const flow = newFlow();
    const state: GoogleState = {
      state: flow.state, verifier: flow.verifier, nonce: flow.nonce, intent,
      ...(linking === undefined ? {} : { owner: linking }),
      ...(intent === "invite" ? { token: body.token as string } : {}),
      expires: Math.floor(nowMs() / 1000) + GOOGLE_SECONDS,
    };
    const url = authUrl({
      clientId: google.clientId, redirectUri, state: flow.state, challenge: await challengeFor(flow.verifier), nonce: flow.nonce,
    });
    const cookie = `${GOOGLE_COOKIE}=${await sign(JSON.stringify(state))}; Path=/; Max-Age=${GOOGLE_SECONDS}; HttpOnly; Secure; SameSite=Lax`;
    return json(200, { url }, [cookie]);
  }

  async function readGoogleState(request: Request): Promise<GoogleState | null> {
    const text = await unsign(readCookie(request, GOOGLE_COOKIE));
    if (text === null) return null;
    try {
      const parsed = JSON.parse(text) as Partial<GoogleState> | null;
      if (parsed === null || typeof parsed !== "object") return null;
      const { state, verifier, nonce, intent, expires } = parsed;
      if (typeof state !== "string" || typeof verifier !== "string" || typeof nonce !== "string" || typeof expires !== "number") return null;
      if (intent !== "sign-in" && intent !== "link" && intent !== "invite") return null;
      if (expires * 1000 <= nowMs()) return null;
      return {
        state, verifier, nonce, intent, expires,
        ...(typeof parsed.owner === "string" ? { owner: parsed.owner } : {}),
        ...(typeof parsed.token === "string" ? { token: parsed.token } : {}),
      };
    } catch {
      return null;
    }
  }

  async function googleCallback(request: Request, url: URL): Promise<Response> {
    const refuse = (code: string): Response => redirect(`/#google=${code}`, [clearedGoogle]);
    const done = async (to: string, who?: { id: string; generation: number }): Promise<Response> =>
      redirect(to, who === undefined ? [clearedGoogle] : [...await signedInCookies(who.id, who.generation), clearedGoogle]);

    if (google === null) return refuse("unavailable");
    const flow = await readGoogleState(request);
    const given = url.searchParams.get("state");
    if (flow === null || given === null || !sameText(flow.state, given)) return refuse("state");
    const code = url.searchParams.get("code");
    if (url.searchParams.has("error") || code === null || code === "") return refuse("denied");

    const claims = await exchange({
      fetch: config.fetch, clientId: google.clientId, clientSecret: google.clientSecret, redirectUri,
      code, verifier: flow.verifier, nonce: flow.nonce, now: config.now(),
    });
    if (!claims.ok) return refuse("failed");

    // 1. Link the identity to the account that asked.
    if (flow.intent === "link") {
      if (flow.owner === undefined || !(await store.linkGoogle(flow.owner, claims.sub))) return refuse("taken");
      return done("/account");
    }

    // 2. Make the account an invitation offered. A Google account already linked elsewhere
    //    is refused and the invitation kept, so it can still be used another way.
    if (flow.intent === "invite") {
      if (flow.token === undefined || flow.token === "") return refuse("invite");
      const id = crypto.randomUUID();
      const hashed = await sha256Hex(flow.token);
      if ((await store.pendingPersonInvite(hashed)) !== null) {
        // By first name: Google says the address.
        const named = await store.acceptPersonInvite(hashed, { id, email: claims.email, passwordHash: null, googleSub: claims.sub });
        if (!named.made) return refuse(named.why === "taken" ? "taken" : "invite");
        return done("/", { id, generation: 0 });
      }
      const accepted = await store.acceptInvite(hashed, { id, passwordHash: null, googleSub: claims.sub });
      if (!accepted.made) return refuse(accepted.why === "taken" ? "taken" : "invite");
      return done("/", { id, generation: 0 });
    }

    const found = await store.accountsForGoogle(claims.sub, claims.email);
    // 3. The identity is already linked.
    const linked = found.find((a) => a.googleSub === claims.sub);
    if (linked) return done("/", { id: linked.id, generation: linked.generation });
    // 4. A confirmed account has this address: both sides proved the same address. Linked here
    //    without asking, so the page says it was. An account at this address that already has
    //    another Google account linked is named as such: Google has just proved the address, so
    //    saying an account is there tells the person nothing they could not find out.
    const byEmail: AccountSecret | undefined = found.find((a) => a.email === claims.email);
    if (byEmail) {
      if (byEmail.googleSub !== null) return refuse("other");
      if (!byEmail.confirmed) return refuse("unknown");
      if (!(await store.linkGoogle(byEmail.id, claims.sub))) return refuse("taken");
      return done("/#google=linked", { id: byEmail.id, generation: byEmail.generation });
    }
    // 5. The first sign-in claims OWNER while nobody has; with an operator address, only that one.
    if ((operatorEmail === "" || claims.email === operatorEmail) && (await claimable())) {
      const made = await store.createAccount({ id: owner, email: claims.email, passwordHash: null, googleSub: claims.sub, confirmed: true });
      return made ? done("/", { id: owner, generation: 0 }) : refuse("taken");
    }
    // 6. Nobody here uses that Google account.
    return refuse("unknown");
  }

  async function unlinkGoogle(request: Request): Promise<Response> {
    const held = await hold(request);
    if ("refused" in held) return json(401, { error: held.refused });
    if (await store.unlinkGoogle(held.session.id)) return json(200, { ok: true });
    const account = await store.account(held.session.id);
    if (account === null) return json(401, { error: GONE });
    if (account.googleSub === null) return json(409, { error: "Google is not linked." });
    return json(409, { error: "Set a password first. Google is your only way in right now." });
  }

  return {
    describe,

    async resolve(request): Promise<Resolution> {
      const held = await hold(request);
      if ("refused" in held) return { refused: held.refused };
      return resolution(held.session);
    },

    // The session's row rides in the read's own first round trip (`readingAs`), and what the
    // read found is only handed on once that row has said the session stands.
    async resolveRead(request, read) {
      const held = await signed(request);
      if ("refused" in held) return { refused: held.refused };
      const { id, generation } = held.session;
      const reading = store.readingAs(id, generation);
      const answer = await read(id, reading.store);
      const stands = standing(held.session, await reading.holds());
      if ("refused" in stands) return { refused: stands.refused };
      return { ...await resolution(held.session), read: answer };
    },

    claimOwner,

    async handle(request) {
      const url = new URL(request.url);
      if (!url.pathname.startsWith("/auth/")) return null;
      if (missing.length > 0) return json(503, { error: `not configured: ${missing.join(", ")} unset` });

      if (request.method === "GET") {
        switch (url.pathname) {
          case "/auth/me": return me(request);
          case "/auth/invites": return invites(request);
          case "/auth/people": return people(request);
          case "/auth/google/callback": return googleCallback(request, url);
          case "/auth/move-in": return moveIn(url);
          default: return json(405, { error: "POST only" });
        }
      }
      if (request.method !== "POST") return json(405, { error: "POST only" });
      // Every auth write must come from the page itself.
      if (request.headers.get("origin") !== config.origin) return json(403, { error: "cross-origin request refused" });
      if (!sentJson(request)) {
        return json(415, { error: "send JSON" });
      }
      // No sign-in, invite or reset body is more than a few hundred bytes.
      const capped = await capBody(request, AUTH_BODY_MAX);
      if (!capped.ok) return capped.response;
      let parsed: unknown = null;
      try { parsed = JSON.parse(capped.text); } catch { /* an unreadable body is an empty one */ }
      const body = typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};

      switch (url.pathname) {
        case "/auth/sign-in": return signIn(request, body);
        case "/auth/sign-out": return json(200, { signedIn: false }, [clearedSession, signedOutMark]);
        case "/auth/sign-out-everywhere": return signOutEverywhere(request);
        case "/auth/password": return changePassword(request, body);
        case "/auth/claim": return claim(body);
        case "/auth/two-step/setup": return twoStepSetup(request);
        case "/auth/two-step/verify": return twoStepVerify(request, body);
        case "/auth/two-step/off": return twoStepOff(request, body);
        case "/auth/recovery/new": return recoveryNew(request, body);
        case "/auth/recover": return recover(request, body);
        case "/auth/reset": return reset(body);
        case "/auth/invite": return invite(request, body);
        case "/auth/invite/accept": return acceptInvite(body);
        case "/auth/invite/withdraw": return withdrawInvite(request, body);
        case "/auth/people/invite": return inviteByName(request, body);
        case "/auth/people/withdraw": return withdrawPerson(request, body);
        case "/auth/people/remove": return removePerson(request, body);
        case "/auth/people/reset": return resetPerson(request, body);
        case "/auth/link": return linkFor(body);
        case "/auth/google/start": return googleStart(request, body);
        case "/auth/google/unlink": return unlinkGoogle(request);
        default: return json(404, { error: "not found" });
      }
    },
  };
}
