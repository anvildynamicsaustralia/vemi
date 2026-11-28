/**
 * The copies this browser knows, kept by the VEMI home page (the front's `/`) so a person who
 * lands there can open their own VEMI in one press instead of remembering its address. Pure
 * apart from `loadCopies` and `saveCopies`, which touch only this origin's storage and never
 * throw. Nothing here is secret: an address and when it was last opened.
 */

/** Where the list lives, on the front's origin (the home page and the setup page share it). */
export const COPIES_KEY = "vemi:home:copies:v1";

/** At most this many are kept; the oldest goes first. */
export const COPIES_MAX = 6;

export interface KnownCopy {
  /** The copy's origin: `https://name.example.workers.dev`. */
  readonly address: string;
  /** When it was last opened or added, in milliseconds. */
  readonly last: number;
}

const LOCAL = /^(localhost|127\.0\.0\.1|\[::1\])$/;

/**
 * The origin a typed address names, or null when it cannot be one. Takes what people type:
 * `vemi-app.example.com`, `https://name.workers.dev/today`, with spaces or a trailing dot.
 * Only `https`, except on this machine, where `http` is how a local copy runs.
 */
export function addressFrom(text: string): string | null {
  const typed = text.trim().replace(/\s+/g, "").replace(/\.$/, "");
  if (typed === "") return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(typed) ? typed : `https://${typed}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return null;
  }
  const domain = url.hostname.toLowerCase();
  if (url.username !== "" || url.password !== "") return null;
  if (url.protocol === "http:" && !LOCAL.test(domain)) return null;
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  // A real address has a dot and a name either side of it; `localhost` is the one exception.
  if (!LOCAL.test(domain) && !/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(domain)) return null;
  return url.origin;
}

/** Why a typed address will not do, in words for under the field; null when it will. */
export function addressProblem(text: string): string | null {
  if (text.trim() === "") return "Type your VEMI's address.";
  return addressFrom(text) === null ? "That does not look like an address. It looks like name.workers.dev." : null;
}

/** The address as a person reads it: no `https://`. */
export const shownAddress = (address: string): string => address.replace(/^https:\/\//, "");

/** The list with `address` first and freshly dated, no repeat, at most `COPIES_MAX` long. */
export function rememberCopy(list: readonly KnownCopy[], address: string, now: number): KnownCopy[] {
  return [{ address, last: now }, ...list.filter((c) => c.address !== address)].slice(0, COPIES_MAX);
}

export const forgetCopy = (list: readonly KnownCopy[], address: string): KnownCopy[] => list.filter((c) => c.address !== address);

/** The kept list, read leniently: anything that is not a sound entry is dropped, never thrown on. */
export function readCopies(text: string | null): KnownCopy[] {
  if (text === null) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: KnownCopy[] = [];
  for (const item of parsed) {
    if (typeof item !== "object" || item === null) continue;
    const { address, last } = item as Record<string, unknown>;
    if (typeof address !== "string" || typeof last !== "number") continue;
    const origin = addressFrom(address);
    if (origin === null || out.some((c) => c.address === origin)) continue;
    out.push({ address: origin, last });
  }
  return out.sort((a, b) => b.last - a.last).slice(0, COPIES_MAX);
}

/** The address a copy's "Add to the home page" link carries (`?mine=`), when it is sound. */
export function mineFrom(search: string): string | null {
  const value = new URLSearchParams(search).get("mine");
  return value === null ? null : addressFrom(value);
}

/** Where a copy is opened from the home page: its sign-in, straight away, past its own front page. */
export const openLinkOf = (address: string): string => `${address}/?signin`;

export function loadCopies(): KnownCopy[] {
  try {
    return readCopies(globalThis.localStorage?.getItem(COPIES_KEY) ?? null);
  } catch {
    return [];
  }
}

export function saveCopies(list: readonly KnownCopy[]): void {
  try {
    globalThis.localStorage?.setItem(COPIES_KEY, JSON.stringify(list));
  } catch {
    // A browser that keeps nothing still opens the copy; it only asks for the address again.
  }
}
