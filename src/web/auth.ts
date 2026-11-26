/**
 * Signing in, from the client's side. The Worker's `/auth/*` routes do the checking; this only
 * carries the browser's half there and back. Email and password, or Google. No library.
 */

import { fetchOrEarly } from "./earlyAnswers.js";
import { withPatience } from "./patience.js";
import type { PeopleList } from "./peopleRows.js";

export interface Me {
  readonly signedIn: boolean;
  /** Whether the Worker can start a Google sign-in. */
  readonly googleReady: boolean;
  /** Signed out only: no owner account exists yet, so this copy can be claimed. */
  readonly claimable?: boolean;
  /** The rest is present only when signed in. */
  /** This account's id: the record its sealed settings are bound to. */
  readonly id?: string;
  readonly email?: string;
  readonly operator?: boolean;
  /** Whether the account has a password. */
  readonly password?: boolean;
  /** Whether a Google account is linked. */
  readonly google?: boolean;
  /** Whether the account asks for a code from an authenticator app at sign-in. */
  readonly twoStep?: boolean;
  /** The day this account is due to go, when its deletion is scheduled; null when it is not. */
  readonly deleteOn?: string | null;
}

export interface Invite {
  readonly email: string;
  readonly expiresAt: string;
}

/** Said when no answer came at all: the browser's own words are "Failed to fetch" or "Load failed". */
export const UNREACHABLE = "Couldn't reach VEMI. Check your connection and try again.";

/**
 * A refusal, in the Worker's own sentence. `status` is 0 when nothing answered. `code` is what
 * the page reads to tell one refusal from another, so no sentence is matched on: `"link"` is a
 * link that has expired or was spent.
 */
export class AuthError extends Error {
  constructor(readonly status: number, message: string, readonly code: string | null = null) {
    super(message);
    this.name = "AuthError";
  }
}

/** A failure to reach the Worker and an answer with no sentence of its own both read as one. */
async function call<T>(path: string, init: RequestInit, send: (path: string, init: RequestInit) => Promise<Response> = fetch): Promise<T> {
  let response: Response;
  try {
    response = await send(path, init);
  } catch {
    throw new AuthError(0, UNREACHABLE);
  }
  const data = await response.json().catch(() => ({})) as { error?: unknown; code?: unknown };
  if (!response.ok) {
    throw new AuthError(
      response.status,
      // Over HTTP/2 there is no status text, so a bare answer would otherwise say nothing.
      typeof data.error === "string" ? data.error : `Something went wrong (${response.status}). Try again.`,
      typeof data.code === "string" ? data.code : null,
    );
  }
  return data as T;
}

export async function post<T>(path: string, body: unknown = {}): Promise<T> {
  return call<T>(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/**
 * A weak signal can hang this for minutes. Past the patience the caller gets a rejection, and
 * the gate shows what this device kept. `patient: false` waits as long as the browser does.
 */
export async function me({ patient = true }: { readonly patient?: boolean } = {}): Promise<Me> {
  const asked = call<Me>("/auth/me", { headers: { accept: "application/json" } }, fetchOrEarly);
  return patient ? withPatience(asked) : asked;
}

/**
 * A sign-out the Worker has not heard yet. The session cookie is HttpOnly, so only the
 * Worker's answer can clear it: signed out with no connection, the device would be signed
 * straight back in by the next start. Kept until the Worker hears it, or until the person
 * signs in again, which is a session they asked for.
 */
const PENDING_SIGN_OUT = "vemi:pending-sign-out:v1";

function pendSignOut(pending: boolean): void {
  try {
    if (pending) localStorage.setItem(PENDING_SIGN_OUT, "1");
    else localStorage.removeItem(PENDING_SIGN_OUT);
  } catch {
    // Without storage the next start trusts the cookie. Nothing better is on offer.
  }
}

export function signOutPending(): boolean {
  try {
    return localStorage.getItem(PENDING_SIGN_OUT) === "1";
  } catch {
    return false;
  }
}

/**
 * A sign-out kept from earlier goes first, so the Worker forgets that session instead of
 * keeping it until it runs out. Still unheard, the new session is the one the person asked for.
 */
async function signedIn<T>(work: () => Promise<T>): Promise<T> {
  await finishSignOut();
  const done = await work();
  pendSignOut(false);
  return done;
}

/** The refusal that asks for a code, or says the one sent did not work: the password was right. */
export function asksForCode(err: unknown): boolean {
  return err instanceof AuthError && err.status === 401 && err.code === "two-step";
}

/** `code` is a six-digit code from the app or a backup code, sent only once the Worker has asked for it. */
export async function signIn(email: string, password: string, code?: string): Promise<void> {
  await signedIn(() => post("/auth/sign-in", code === undefined ? { email, password } : { email, password, code }));
}

/** Whether the Worker heard it. When it did not, it is kept to finish with `finishSignOut`. */
export async function signOut(): Promise<boolean> {
  try {
    await post("/auth/sign-out");
    pendSignOut(false);
    return true;
  } catch {
    pendSignOut(true);
    return false;
  }
}

/** Sends a sign-out kept from earlier. True when none is left waiting. */
export async function finishSignOut(): Promise<boolean> {
  return !signOutPending() || await signOut();
}

/**
 * Makes the owner account on a fresh copy from the email and password sent, and signs this
 * device in. Refused once the copy has an owner.
 */
export async function claim(email: string, password: string): Promise<string> {
  return recoveryOf(await signedIn(() => post<RecoveryAnswer>("/auth/claim", { email, password })));
}

interface RecoveryAnswer {
  readonly recoveryCode?: string;
}

/** The recovery code an answer carries, shown once; empty when the Worker sent none. */
const recoveryOf = (answer: RecoveryAnswer): string => (typeof answer.recoveryCode === "string" ? answer.recoveryCode : "");

/**
 * The address a link was made for, asked without spending it. Rejects with code `"link"`
 * when the link has expired or was already used, so the page says so before anyone types.
 */
export async function linkEmail(kind: "reset" | "invite", token: string): Promise<string> {
  const { email } = await post<{ email: string }>("/auth/link", { token, purpose: kind });
  return email;
}

/**
 * What the Worker says of a link before anything is typed: the address it was made for, or, for an
 * invitation by first name, that name (the invitee gives their address when they accept).
 */
export type LinkHolder = { readonly email: string } | { readonly firstName: string };

export async function linkHolder(kind: "reset" | "invite", token: string): Promise<LinkHolder> {
  const answer = await post<{ email?: string; firstName?: string }>("/auth/link", { token, purpose: kind });
  return typeof answer.firstName === "string" ? { firstName: answer.firstName } : { email: answer.email ?? "" };
}

/** Each of these spends the token, and signs this device in. */
export async function reset(token: string, password: string): Promise<void> {
  await signedIn(() => post("/auth/reset", { token, password }));
}

/** Returns the recovery code to show once. */
export async function acceptInvite(token: string, password: string, email?: string): Promise<string> {
  const body = email === undefined ? { token, password } : { token, password, email };
  return recoveryOf(await signedIn(() => post<RecoveryAnswer>("/auth/invite/accept", body)));
}

/**
 * Sets a new password from the recovery code, without the old one or the app. Signs this
 * device in. Returns the new recovery code to show once.
 */
export async function recover(email: string, recoveryCode: string, password: string): Promise<string> {
  return recoveryOf(await signedIn(() => post<RecoveryAnswer>("/auth/recover", { email, recoveryCode, password })));
}

/** The key 2-step setup shows: as text to type, and as the address a QR code carries. */
export interface TwoStepKey {
  readonly secret: string;
  readonly uri: string;
}

/** Starts 2-step setup. Not on until a code from the app is sent to `twoStepVerify`. */
export const twoStepSetup = (): Promise<TwoStepKey> => post<TwoStepKey>("/auth/two-step/setup");

/** Turns 2-step on with the first code. Returns the backup codes, shown once. */
export async function twoStepVerify(code: string): Promise<readonly string[]> {
  const { backupCodes } = await post<{ backupCodes?: string[] }>("/auth/two-step/verify", { code });
  return backupCodes ?? [];
}

/** Turns 2-step off. Asks for the password. */
export async function twoStepOff(password: string): Promise<void> {
  await post("/auth/two-step/off", { password });
}

/** A new recovery code, shown once; the old one stops working. Asks for the password. */
export async function newRecoveryCode(password: string): Promise<string> {
  return recoveryOf(await post<RecoveryAnswer>("/auth/recovery/new", { password }));
}

/** Leaves for Google. The Worker answers with the address and a short-lived cookie. */
export async function googleStart(intent: "sign-in" | "link" | "invite", token?: string): Promise<void> {
  // A sign-out kept from earlier goes first: someone who turns back at Google is still out.
  if (intent !== "link") await finishSignOut();
  const { url } = await post<{ url: string }>("/auth/google/start", token === undefined ? { intent } : { intent, token });
  // Google answers with a session cookie the next start must not sign out again.
  if (intent !== "link") pendSignOut(false);
  window.location.assign(url);
}

export async function changePassword(current: string, next: string): Promise<void> {
  await post("/auth/password", { current, next });
}

export async function signOutEverywhere(): Promise<void> {
  await post("/auth/sign-out-everywhere");
}

export async function unlinkGoogle(): Promise<void> {
  await post("/auth/google/unlink");
}

/** Operator only: make an invite and get its link to pass on. Made again for the same address, it replaces the one before. */
export async function invite(email: string): Promise<string> {
  const { link } = await post<{ link: string }>("/auth/invite", { email });
  return link;
}

/** Operator only: withdraw a waiting invite, so its link no longer opens an account. */
export async function withdrawInvite(email: string): Promise<void> {
  await post("/auth/invite/withdraw", { email });
}

/** Operator only: the invites not yet taken or run out. */
export async function invites(): Promise<readonly Invite[]> {
  const { invites: pending } = await call<{ invites?: Invite[] }>("/auth/invites", { headers: { accept: "application/json" } });
  return pending ?? [];
}

/** Owner only: the people who joined, and the invitations by first name still waiting. */
export async function people(): Promise<PeopleList> {
  const list = await call<Partial<PeopleList>>("/auth/people", { headers: { accept: "application/json" } });
  return { people: list.people ?? [], invites: list.invites ?? [] };
}

/** Owner only: a link for a first name, to pass on. Nothing is sent. */
export async function invitePerson(firstName: string): Promise<string> {
  const { link } = await post<{ link: string }>("/auth/people/invite", { firstName });
  return link;
}

/** Owner only: a waiting invitation, by its id, so its link no longer works. */
export async function withdrawPerson(id: string): Promise<void> {
  await post("/auth/people/withdraw", { id });
}

/** Owner only: schedules one of their people to go, as the person could themselves. Returns the date. */
export async function removePerson(id: string): Promise<string> {
  const { deleteOn } = await post<{ deleteOn: string }>("/auth/people/remove", { id });
  return deleteOn;
}

/** Owner only: a link that sets a new password for one of their people, good for a day. */
export async function resetPersonLink(id: string): Promise<string> {
  const { link } = await post<{ link: string }>("/auth/people/reset", { id });
  return link;
}
