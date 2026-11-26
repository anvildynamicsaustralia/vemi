/**
 * The identity check, behind an interface. VEMI-002 decision 33, kept.
 *
 * Nothing in this file knows how a person proves who they are. It declares what a check
 * must do; the implementation lives in `accountIdentity.ts` with `password.ts` and
 * `google.ts`, and `tests/identity-one-file.test.ts` fails if another file learns it.
 * Passkeys left in VEMI-010.
 *
 * An implementation owns its own routes — signing in, resetting, accepting an invite —
 * because only it knows what those are. The application asks it first and routes
 * whatever it declines.
 */
import type { Store } from "./store.js";

/**
 * An owner, or a refusal naming what was seen. `renew` is a `Set-Cookie` value for the
 * response to carry when the proof is wearing out, so a person in daily use is never signed
 * out by the calendar. The application passes it on and never reads it.
 */
export type Resolution = { readonly owner: string; readonly renew?: string } | { readonly refused: string };

/** A resolution that held, with what the read it guarded answered. */
export type ReadResolution<T> =
  | { readonly owner: string; readonly renew?: string; readonly read: T }
  | { readonly refused: string };

/** What making the owner account answers: the recovery code and a short-lived hand-over, or a refusal in one sentence. */
export type OwnerClaim =
  | { readonly recoveryCode: string; readonly handOver: string }
  | { readonly refused: { readonly status: number; readonly error: string } };

export interface Identity {
  /** One line saying what kind of check this is and whether it is set up. */
  readonly describe: string;
  /** The owner behind a request, or a refusal. Never throws. Fails closed when unconfigured. */
  resolve(request: Request): Promise<Resolution>;
  /**
   * `resolve` and a read together. `read` runs for the owner the proof names, against a store
   * the implementation may fold its own check into, so an authenticated read can cost one
   * round trip to the database rather than two. What `read` answers comes back only when the
   * proof held; otherwise the refusal does, and the answer is dropped. Only for what changes
   * nothing, because `read` may run before the check has said it may.
   */
  resolveRead<T>(request: Request, read: (owner: string, store: Store) => Promise<T>): Promise<ReadResolution<T>>;
  /**
   * The mechanism's own routes. `null` for a request that is not one of them. Work handed to
   * `waitUntil` runs after the response, as `ctx.waitUntil` does.
   */
  /**
   * Makes the copy's owner account from an email and a password, under the rules a first
   * sign-up has, for a caller that has already proved it may (the move door). Refuses while
   * an owner exists. `handOver` is a token good for five minutes and one use at
   * `/auth/move-in`, which signs the person in.
   */
  claimOwner(email: string, password: string): Promise<OwnerClaim>;
  handle(request: Request, waitUntil: (work: Promise<unknown>) => void): Promise<Response | null>;
}
