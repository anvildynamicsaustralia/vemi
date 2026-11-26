/**
 * What the sign-in card adds to a refused password sign-in. Pure, so the copy is tested
 * without a page. The Worker answers a wrong password, an unknown address and a Google-only
 * account with one sentence, so no address is confirmed; the card can still name the other
 * way in it offers, which says nothing about any account. There is no mail, so a refusal
 * never points at a link to be sent.
 */
import { AuthError } from "./auth.js";

export interface WaysIn {
  /** The card shows Continue with Google. */
  readonly googleReady: boolean;
}

export function signInRefused(err: unknown, { googleReady }: WaysIn): string {
  const said = err instanceof Error ? err.message : String(err);
  if (!(err instanceof AuthError)) return said;
  if (err.status === 401) return googleReady ? `${said} If you joined with Google, use Continue with Google.` : said;
  if (err.status === 429 && googleReady) return `${said} Continue with Google still works if your account uses it.`;
  return said;
}
