/**
 * What a copy keeps in this browser about someone who has signed in here before, so the next
 * visit opens on the sign-in card (not the front page) with the email already in. Never the
 * password, never a session: an email and a yes. Signing out keeps them, so signing back in is
 * quick; "Not you?" on the card forgets them.
 */
const BEEN_KEY = "vemi:returning:v1";

export interface Returning {
  /** Someone has signed in on this browser before. */
  readonly been: boolean;
  /** The email they signed in with, or "" when it was not kept. */
  readonly email: string;
}

const NONE: Returning = { been: false, email: "" };

export function readReturning(text: string | null): Returning {
  if (text === null) return NONE;
  try {
    const parsed = JSON.parse(text) as unknown;
    if (typeof parsed !== "object" || parsed === null) return NONE;
    const { email } = parsed as Record<string, unknown>;
    return { been: true, email: typeof email === "string" && email.length <= 320 ? email : "" };
  } catch {
    return NONE;
  }
}

export function loadReturning(): Returning {
  try {
    return readReturning(globalThis.localStorage?.getItem(BEEN_KEY) ?? null);
  } catch {
    return NONE;
  }
}

/** Kept after a sign-in that held. */
export function keepReturning(email: string): void {
  try {
    globalThis.localStorage?.setItem(BEEN_KEY, JSON.stringify({ email: email.trim() }));
  } catch {
    // Kept nowhere: the next visit shows the front page and an empty card, as a first one does.
  }
}

export function forgetReturning(): void {
  try {
    globalThis.localStorage?.removeItem(BEEN_KEY);
  } catch {
    // Nothing kept to forget.
  }
}

/** The address opened with `?signin` (the home page's Open, or a bookmark): go to the card. */
export const asksForSignIn = (search: string): boolean => new URLSearchParams(search).has("signin");
