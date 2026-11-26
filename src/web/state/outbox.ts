/**
 * Writes that survive having no connection.
 *
 * A write made with no route to the Worker is kept, the interface says how many are
 * waiting, and they go in order the moment the Worker answers again.
 *
 * **Only a failure to reach the Worker is queued.** A 400 is the Worker saying no and goes
 * straight back to the caller: queueing a refusal would retry it for ever and tell somebody
 * their edit was saved when it was rejected.
 *
 * Kept in `localStorage`, because the case this exists for is a phone in a pocket, and the
 * tab is discarded long before the signal comes back.
 *
 * **Each write belongs to the account that made it.** A device can be signed out and signed
 * into another account with writes still waiting, and the cookie a drain carries is whoever is
 * signed in at that moment. So every row is stamped with its account, only the account signed
 * in now has its rows sent, and another account's rows are discarded unsent the moment a
 * different account is known to be the one here.
 */

const KEY = "vemi:outbox:v1";

/** A queued write is small. A hundred of them is a bug, not a backlog. */
export const MAX_QUEUED = 100;

export interface Queued {
  readonly id: string;
  readonly url: string;
  readonly method: string;
  readonly body: string | null;
  readonly at: string;
  /** The account signed in when the write was made: the email `/auth/me` answers with. */
  readonly account: string;
}

type Listener = (waiting: number) => void;
const listeners = new Set<Listener>();

export function onWaiting(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** What is waiting, oldest first. */
export function queued(): Queued[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw === null) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed as Queued[] : [];
  } catch {
    // A storage that will not answer is an empty outbox, not a broken interface.
    return [];
  }
}

/** Whose writes are kept and sent. `null` while nobody is known to be signed in. */
let owner: string | null = null;

/**
 * Says which account is signed in on this device, or that none is. Rows another account
 * queued are discarded, unsent, and the count is returned so the person can be told.
 *
 * Nobody (`null`) discards nothing: a session that ran out signs the device out, and the same
 * person signing back in still wants what they made offline.
 */
export function ownOutbox(account: string | null): number {
  owner = account;
  if (account === null) return 0;
  const rows = queued();
  const theirs = rows.filter((row) => row.account === account);
  if (theirs.length !== rows.length) save(theirs);
  return rows.length - theirs.length;
}

/** Everything waiting, gone: for someone who chose to sign out and was told what it costs. */
export function clearOutbox(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    // Storage that will not answer was holding nothing that can be sent.
  }
  for (const listener of listeners) listener(0);
}

function save(rows: readonly Queued[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(rows));
  } catch {
    // Nothing to be done, and not worth taking the page down for.
  }
  for (const listener of listeners) listener(rows.length);
}

/** Removed by id and read fresh, so a write queued while a drain runs is never overwritten. */
function remove(id: string): void {
  save(queued().filter((row) => row.id !== id));
}

/** Kept for the account signed in. With nobody known to be signed in, nothing is kept. */
export function enqueue(entry: Omit<Queued, "id" | "at" | "account">, now = new Date()): Queued[] {
  const rows = queued();
  if (owner === null || rows.length >= MAX_QUEUED) return rows;
  const id = `${now.getTime().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  const next = [...rows, { ...entry, id, at: now.toISOString(), account: owner }];
  save(next);
  return next;
}

export function isWrite(method: string): boolean {
  const m = method.toUpperCase();
  return m === "POST" || m === "PUT" || m === "PATCH" || m === "DELETE";
}

/** `fetch` rejects only when there was nobody to ask. Every answer, a refusal included, resolves. */
export function isUnreachable(err: unknown): boolean {
  return err instanceof TypeError || (err as { name?: string } | null)?.name === "TypeError";
}

/**
 * An answer that says "not now" rather than "no": signed out, overloaded, or broken for the
 * moment. The write is kept and tried again later, because dropping it would lose it for a
 * reason that has nothing to do with the write.
 */
export function isNotNow(status: number): boolean {
  return status === 401 || status === 408 || status === 429 || status >= 500;
}

export interface Drained {
  readonly sent: number;
  readonly refused: number;
  readonly left: number;
  /** The Worker answered 401: this device's session is over, and the rest wait for a sign-in. */
  readonly signedOut: boolean;
}

let draining: Promise<Drained> | null = null;

/**
 * Send what is waiting, oldest first.
 *
 * Stops at the first that cannot be reached, or that the Worker cannot take right now, and
 * keeps the rest, because order is what makes a queue of edits mean anything. One the Worker
 * refuses is dropped with the reason reported: it would be refused for ever. Only the rows of
 * the account signed in now are sent, and with nobody signed in nothing is.
 *
 * One drain at a time. Coming back online and the live channel reconnecting both ask for
 * one, and two running together would send the same write twice.
 */
export function drain(
  doFetch: typeof fetch = fetch,
  onRefused?: (entry: Queued, reason: string) => void,
): Promise<Drained> {
  draining ??= send(doFetch, onRefused).finally(() => {
    draining = null;
  });
  return draining;
}

async function send(doFetch: typeof fetch, onRefused?: (entry: Queued, reason: string) => void): Promise<Drained> {
  let sent = 0;
  let refused = 0;
  let signedOut = false;
  for (;;) {
    // Read fresh each time round: a sign-out or a change of account can land mid-drain.
    const entry = owner === null ? undefined : queued().find((row) => row.account === owner);
    if (entry === undefined) break;
    try {
      const response = await doFetch(entry.url, {
        method: entry.method,
        headers: entry.body === null ? {} : { "content-type": "application/json" },
        ...(entry.body === null ? {} : { body: entry.body }),
      });
      if (isNotNow(response.status)) {
        signedOut = response.status === 401;
        break;
      }
      if (response.ok) {
        sent += 1;
      } else {
        refused += 1;
        const said = await response.json().catch(() => null) as { error?: unknown } | null;
        onRefused?.(entry, typeof said?.error === "string" ? said.error : `the Worker answered ${response.status}`);
      }
    } catch (err: unknown) {
      if (isUnreachable(err)) break;
      refused += 1;
      onRefused?.(entry, String(err));
    }
    remove(entry.id);
  }
  return { sent, refused, left: queued().length, signedOut };
}

/**
 * `fetch`, with the outbox behind it. A queued write answers `202 Accepted`, which is true:
 * this device has accepted it, and nothing else has yet.
 */
export function apiFetch(input: string, init: RequestInit = {}, doFetch: typeof fetch = fetch): Promise<Response> {
  const method = init.method ?? "GET";
  const write = isWrite(method);
  if (write) sending += 1;
  return doFetch(input, init)
    .catch((err: unknown) => {
      // With no account known there is nobody to keep it for, and it fails as what it is.
      if (!write || !isUnreachable(err) || owner === null) throw err;
      const body = typeof init.body === "string" ? init.body : null;
      const before = queued().length;
      const rows = enqueue({ url: input, method, body });
      if (rows.length === before) {
        // Full. Saying "kept" here would be the one lie this file exists to prevent.
        return new Response(JSON.stringify({
          error: `This device is already holding ${MAX_QUEUED} changes for when the connection is back, so this one was not kept.`,
        }), { status: 507, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({ queued: true, waiting: rows.length }), {
        status: 202,
        headers: { "content-type": "application/json" },
      });
    })
    .finally(() => {
      if (write) sending -= 1;
    });
}

/** Writes on their way to the Worker this moment. A reload into a new build waits for none. */
let sending = 0;

export function writesInFlight(): number {
  return sending;
}
