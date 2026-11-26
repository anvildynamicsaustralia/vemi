/**
 * Who this device opens as, decided without touching storage, the network or React. The gate
 * in `App.tsx` reads and writes; this says what follows from what it read.
 */

import type { Me } from "./auth.js";

export type Gate = "checking" | "in" | "out";

/** The account an offline start opens as, from what was stored. "1" is from before the account was kept, and names nobody. */
export function accountFrom(stored: string | null): string | null {
  return stored === null || stored === "1" ? null : stored;
}

/**
 * Whether what this device kept goes before `account` is shown anything: a token page that
 * signed someone in over this tab, an account the Worker did not name, or anyone but the one
 * this device last held.
 */
export function mustForget(account: string | null, remembered: string | null, switched: boolean): boolean {
  return switched || account === null || account !== remembered;
}

/** How a start settles, from whether a waiting sign-out was heard and what `/auth/me` said (null: no answer). */
export type Start =
  /** The Worker named who is signed in. */
  | { readonly kind: "enter"; readonly account: string | null }
  /** No answer: the account this device last held, with what it kept. */
  | { readonly kind: "kept"; readonly account: string }
  /** Signed out. `unheard`: by the person, with the Worker yet to hear it, whatever the cookie says. */
  | { readonly kind: "out"; readonly unheard: boolean };

export function startFrom(heard: boolean, answer: Me | null, remembered: string | null): Start {
  if (!heard) return { kind: "out", unheard: true };
  if (answer === null) return remembered === null ? { kind: "out", unheard: false } : { kind: "kept", account: remembered };
  return answer.signedIn ? { kind: "enter", account: answer.email ?? null } : { kind: "out", unheard: false };
}

/** Only a device that is in can be signed out by the Worker. A late 401 after a sign-out says nothing. */
export function heedsSignOut(gate: Gate): boolean {
  return gate === "in";
}

/** True at most once per `ms`: how often a live channel that keeps failing asks whether the session is still there. */
export function oncePer(ms: number): (now: number) => boolean {
  let asked: number | null = null;
  return (now) => {
    if (asked !== null && now - asked < ms) return false;
    asked = now;
    return true;
  };
}

