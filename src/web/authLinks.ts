/**
 * The addresses the Worker sends a browser to: a link to `/reset` or `/invite`
 * with its token in the hash, and Google's refusal handed back as `/#google=<code>`
 * (or `/#google=linked`, when a sign-in linked Google to the account at its address).
 * Pure, so the rules are tested without a page. The hash never reaches the Worker, and
 * `App.tsx` takes it out of the address once it has been read.
 */

export type AuthLink =
  | { readonly kind: "reset" | "invite"; readonly token: string }
  | { readonly kind: "google"; readonly code: string };

const PAGES: Readonly<Record<string, "reset" | "invite">> = {
  "/reset": "reset",
  "/invite": "invite",
};

/** What the Worker makes is 43 characters of base64url; this only turns away what is plainly not one. */
const TOKEN = /^[A-Za-z0-9_-]{16,128}$/;
const CODE = /^[a-z]{1,20}$/;

export function authLinkFrom(pathname: string, hash: string): AuthLink | null {
  const raw = hash.replace(/^#/, "");
  if (pathname === "/") {
    if (!raw.startsWith("google=")) return null;
    const code = raw.slice("google=".length);
    return CODE.test(code) ? { kind: "google", code } : null;
  }
  const kind = PAGES[pathname];
  if (kind === undefined) return null;
  let token: string;
  try {
    token = decodeURIComponent(raw);
  } catch {
    return null;
  }
  return TOKEN.test(token) ? { kind, token } : null;
}

/** Google's callback signed someone in and linked their account at the same address on the way. */
const LINKED = "linked";

/** One sentence for each reason the Google callback turned someone away. */
export function googleSaid(code: string): string {
  switch (code) {
    case "unavailable": return "Google sign-in is not set up here.";
    case "state": return "That Google sign-in expired or came from somewhere else. Try again.";
    case "denied": return "Google sign-in was cancelled.";
    case "taken": return "That Google account already belongs to another VEMI account.";
    case "invite": return "That invite is no longer good. Ask for a new one.";
    case "other": return "The VEMI account for this email is linked to a different Google account. Use that one, or your password if you set one.";
    case "unknown": return "No VEMI account uses that Google account.";
    default: return "Google could not sign you in. Try again.";
  }
}

/** Why Google handed the sign-in card back, or null when the address says nothing went wrong. */
export function googleRefusal(link: AuthLink | null): string | null {
  return link?.kind === "google" && link.code !== LINKED ? googleSaid(link.code) : null;
}

/**
 * What a signed-in person is told on arrival. Linking Google from the account panel comes back
 * through the same callback, so a refusal there has to reach the Shell rather than the sign-in card.
 * A Google sign-in that linked the account at its address says so, since nobody was asked.
 */
export function signedInNotice(link: AuthLink | null): string | null {
  if (link?.kind !== "google") return null;
  return link.code === LINKED ? "Google is now linked to your account. Either way in works from now on." : googleSaid(link.code);
}
