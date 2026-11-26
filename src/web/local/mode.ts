/**
 * Which copy of the app this page is: the one that keeps its data in the browser, served at
 * `/try`, or the signed-in one. Decided from the page's own path, once, before anything
 * draws, and never again: the signed-in app rewrites its own address (an auth link goes back
 * to `/`), and a mode that followed the path would flip in the middle of a session.
 *
 * In local mode the route lives in the hash (`/try/#/today`), so the path stays `/try/`, a
 * real file on every static server, and a refresh needs no rule there.
 */

/** How the router writes a route into the address bar. */
export type RouteMode = "path" | "hash";

/** Whether a path is `/try` or under it. `/trying` and `/get/try` are not. */
export function isLocalPath(pathname: string): boolean {
  return pathname === "/try" || pathname.startsWith("/try/");
}

let decided: boolean | null = null;

/** True on the page served at `/try`. The first call decides; the answer never changes. */
export function isLocal(): boolean {
  if (decided === null) decided = typeof window === "undefined" ? false : isLocalPath(window.location.pathname);
  return decided;
}

/**
 * What the key ways are bound to where there is no email. Locked notes and App lock bind their
 * keys to an account name; a copy kept in the page has one account and no address, so this
 * constant stands in. It is not shown, not sent, and names nobody.
 */
export const LOCAL_KEY_NAME = "local@local.invalid";

/** The address the router reads and writes: the hash in local mode, the path otherwise. */
export function routeMode(): RouteMode {
  return isLocal() ? "hash" : "path";
}
