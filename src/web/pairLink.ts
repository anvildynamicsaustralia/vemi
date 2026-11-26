/**
 * The link a new device shows to be opened on a device that already holds the key:
 * `<origin>/account#pair=<pairingId>.<publicPart>`. Both parts are base64url, so a dot cannot
 * occur inside either. It all sits in the fragment, which the browser never sends, so the
 * Worker sees the pairing id only when this page asks for it, and never the public part.
 */

const PART = /^[A-Za-z0-9_-]{1,200}$/;

export interface PairRequest {
  readonly id: string;
  readonly publicPart: string;
}

export function pairLink(origin: string, request: PairRequest): string {
  return `${origin}/account#pair=${request.id}.${request.publicPart}`;
}

/** The request in a link or in a fragment (`#pair=...`), or null when it is anything else. */
export function parsePairLink(text: string): PairRequest | null {
  const at = text.indexOf("#");
  const fragment = at === -1 ? text : text.slice(at + 1);
  if (!fragment.startsWith("pair=")) return null;
  const [id, publicPart, ...extra] = fragment.slice("pair=".length).split(".");
  if (extra.length > 0 || id === undefined || publicPart === undefined) return null;
  if (!PART.test(id) || !PART.test(publicPart)) return null;
  return { id, publicPart };
}

let landed: PairRequest | null = typeof window === "undefined" ? null : parsePairLink(window.location.hash);

/** The link this page was opened with, read once at start before anything rewrites the address. */
export function landedPair(): PairRequest | null {
  return landed;
}

/** Done with the link: forgets it and takes the fragment out of the address bar. */
export function clearLandedPair(): void {
  landed = null;
  if (typeof window !== "undefined" && parsePairLink(window.location.hash) !== null) {
    window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
  }
}
