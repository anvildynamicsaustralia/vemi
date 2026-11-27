/**
 * Where the interface is, as a path. The map is home, and every surface that belongs to a
 * venture is reached through one (VEMI-006 decisions 3 and 4).
 *
 *   /  /map                       the map
 *   /ventures/:id                 a venture, on its Board
 *   /ventures/:id/:tab            board | projects
 *   /ventures/:id/projects/:pid   a project's own page
 *   /ventures/:id/tasks/:tid      a task's own page, the sheet opened out
 *   /today                        what was picked for today, across every venture
 *   /add  /search  /archive  /account
 *   …?task=:taskId                a task's sheet, over any of them
 *
 * Paths from before VEMI-006 still land somewhere real. `/board/:id` is the venture's board.
 * `/space`, `/tree` and `/board` name no venture, so they go to the map. `/horizon` and
 * `/ventures/:id/today` are Today, which is no one venture's. Nothing
 * 404s and no saved link dies silently. The shell rewrites any of them to the path it
 * resolved to, so the address bar never shows a path that no longer exists.
 *
 * In local mode (the copy at `/try`, which keeps its data in the browser) the same table is
 * written after a `#`: `/try/#/today`. The path stays `/try/`, a real file on every static server, so
 * a refresh needs no rule there. The mode is `path` or `hash`; every function that
 * builds or reads an address takes it, and defaults to the page's own.
 *
 * A history router in a page of code rather than a dependency: the whole of what it has to
 * know fits in this table.
 */
import { useSyncExternalStore } from "react";
import { routeMode, type RouteMode } from "./local/mode.js";
import { onSheetEntry } from "./sheetHistory.js";

export type Surface = "map" | "venture" | "project" | "task" | "today" | "add" | "search" | "archive" | "account" | "review" | "upcoming";

/** The two surfaces inside a venture, in the order the tab pill shows them. */
export const TABS = ["board", "projects"] as const;
export type Tab = (typeof TABS)[number];

export interface Route {
  readonly surface: Surface;
  /** Set exactly when the surface is `venture`. */
  readonly ventureId: string | null;
  /** Set for a venture and for the pages inside it: the tab the pill shows as open. */
  readonly tab: Tab | null;
  /** The project or task a page is about. Set when the surface is `project` or `task`. */
  readonly itemId: string | null;
  /** A task's sheet, laid over any surface. */
  readonly taskId: string | null;
}

export const HOME: Route = { surface: "map", ventureId: null, tab: null, itemId: null, taskId: null };

const isTab = (s: string | undefined): s is Tab => (TABS as readonly string[]).includes(s ?? "");

/** A venture's route, on one of its tabs. */
export function venture(id: string, tab: Tab = "board", taskId: string | null = null): Route {
  return { surface: "venture", ventureId: id, tab, itemId: null, taskId };
}

/** A project's own page, inside its venture. The pill shows Projects. */
export function projectPage(ventureId: string, projectId: string, taskId: string | null = null): Route {
  return { surface: "project", ventureId, tab: "projects", itemId: projectId, taskId };
}

/** A task's own page, inside its venture. The pill shows Board, where tasks live. */
export function taskPage(ventureId: string, taskId: string): Route {
  return { surface: "task", ventureId, tab: "board", itemId: taskId, taskId: null };
}

/** One of the surfaces that is not a venture's: the map, today, add, search, archive, account. */
export function surface(to: Exclude<Surface, "venture">, taskId: string | null = null): Route {
  return { surface: to, ventureId: null, tab: null, itemId: null, taskId };
}

/** A path part, decoded. A malformed percent sequence is typed by hand, so it stays as typed. */
function decoded(part: string): string {
  try {
    return decodeURIComponent(part);
  } catch {
    return part;
  }
}

export function parseRoute(pathname: string, search: string): Route {
  const parts = pathname.split("/").filter((p) => p !== "").map(decoded);
  const taskId = new URLSearchParams(search).get("task") || null;
  const [first, second, third, fourth] = parts;
  switch (first) {
    case undefined:
    case "map":
      return surface("map", taskId);
    case "today":
    case "add":
    case "search":
    case "archive":
    case "account":
    case "review":
    case "upcoming":
      return surface(first, taskId);
    // Before the Today phase Today was a venture's tab, and then the horizon. Both are Today.
    case "horizon":
      return surface("today", taskId);
    case "ventures":
      if (second === undefined) return surface("map", taskId);
      if (third === "today") return surface("today", taskId);
      if (third === "projects" && fourth !== undefined) return projectPage(second, fourth, taskId);
      if (third === "tasks" && fourth !== undefined) return taskPage(second, fourth);
      return venture(second, isTab(third) ? third : "board", taskId);
    // Before VEMI-006: the board of a venture is still that board. With no venture, the map.
    case "board":
      return second === undefined ? surface("map", taskId) : venture(second, "board", taskId);
    default:
      return surface("map", taskId);
  }
}

export function routeHref(route: Route, mode: RouteMode = routeMode()): string {
  const v = route.ventureId === null ? null : `/ventures/${encodeURIComponent(route.ventureId)}`;
  const item = route.itemId === null ? "" : encodeURIComponent(route.itemId);
  const base = v === null
    ? route.surface === "venture" || route.surface === "project" || route.surface === "task" || route.surface === "map" ? "/" : `/${route.surface}`
    : route.surface === "project" ? `${v}/projects/${item}`
    : route.surface === "task" ? `${v}/tasks/${item}`
    : route.surface === "venture" ? `${v}/${route.tab ?? "board"}`
    : `/${route.surface}`;
  const href = route.taskId === null ? base : `${base}?task=${encodeURIComponent(route.taskId)}`;
  return mode === "hash" ? `#${href}` : href;
}

/** Where a page's address says the route is: the path and query, or the hash read as one. */
export function routeAddress(mode: RouteMode = routeMode()): { readonly pathname: string; readonly search: string } {
  if (mode === "path") return { pathname: window.location.pathname, search: window.location.search };
  const inner = window.location.hash.slice(1);
  const at = inner.indexOf("?");
  const pathname = at < 0 ? inner : inner.slice(0, at);
  return { pathname: pathname === "" ? "/" : pathname, search: at < 0 ? "" : inner.slice(at) };
}

/**
 * The path a route is written as, when the address bar says something else: an old link to
 * rewrite. Null when the bar already says it.
 */
export function canonical(route: Route, pathname: string, search: string, mode: RouteMode = routeMode()): string | null {
  const href = routeHref(route, "path");
  const task = new URLSearchParams(search).get("task");
  const here = task ? `${pathname}?task=${encodeURIComponent(task)}` : pathname;
  return href === here ? null : routeHref(route, mode);
}

const CHANGE = "vemi:route";

export function navigate(route: Route, options: { readonly replace?: boolean } = {}): void {
  const mode = routeMode();
  const href = routeHref(route, mode);
  if (href === currentHref(mode)) return;
  if (options.replace === true) window.history.replaceState(null, "", href);
  else if (onSheetEntry()) {
    // Opened from inside a sheet: the page takes the sheet's entry, so Back from it goes to
    // where the sheet was opened, and the sheet closing does not step back off the page.
    window.history.replaceState(null, "", href);
  } else window.history.pushState(null, "", href);
  window.dispatchEvent(new Event(CHANGE));
}

/** Calls `listener` when the address may have changed. Answers the way to stop. */
export function subscribe(listener: () => void): () => void {
  window.addEventListener("popstate", listener);
  window.addEventListener("hashchange", listener);
  window.addEventListener(CHANGE, listener);
  return () => {
    window.removeEventListener("popstate", listener);
    window.removeEventListener("hashchange", listener);
    window.removeEventListener(CHANGE, listener);
  };
}

/** The page's address as `routeHref` writes a route, so the two compare. */
export function currentHref(mode: RouteMode = routeMode()): string {
  const { pathname, search } = routeAddress(mode);
  return `${mode === "hash" ? "#" : ""}${pathname}${search}`;
}

let cachedHref = "";
let cachedRoute: Route = HOME;

function current(): Route {
  const href = currentHref();
  if (href !== cachedHref) {
    cachedHref = href;
    const { pathname, search } = routeAddress();
    cachedRoute = parseRoute(pathname, search);
  }
  return cachedRoute;
}

export function useRoute(): Route {
  return useSyncExternalStore(subscribe, current);
}
