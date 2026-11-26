import { afterEach, describe, expect, it, vi } from "vitest";
import { canonical, HOME, parseRoute, projectPage, routeHref, surface, taskPage, venture } from "./router.js";

describe("the router", () => {
  it("reads every surface from its path", () => {
    expect(parseRoute("/", "")).toEqual(HOME);
    expect(parseRoute("/map", "")).toEqual(HOME);
    expect(parseRoute("/today", "")).toEqual(surface("today"));
    expect(parseRoute("/today", "?task=t4")).toEqual(surface("today", "t4"));
    expect(parseRoute("/add", "")).toEqual(surface("add"));
    expect(parseRoute("/search", "")).toEqual(surface("search"));
    expect(parseRoute("/archive", "")).toEqual(surface("archive"));
    expect(parseRoute("/review", "")).toEqual(surface("review"));
    expect(routeHref(surface("review"))).toBe("/review");
    expect(canonical(parseRoute("/review", ""), "/review", "")).toBeNull();
    expect(parseRoute("/account", "?task=t1")).toEqual(surface("account", "t1"));
  });

  it("reaches a venture's surfaces only through the venture", () => {
    expect(parseRoute("/ventures/v1", "")).toEqual(venture("v1", "board"));
    expect(parseRoute("/ventures/v1/board", "?task=t9")).toEqual(venture("v1", "board", "t9"));
    expect(parseRoute("/ventures/v%201/projects", "")).toEqual(venture("v 1", "projects"));
    // A tab it does not know is the venture's Board, not a dead page.
    expect(parseRoute("/ventures/v1/nonsense", "")).toEqual(venture("v1", "board"));
  });

  it("sends the old Today routes to /today, and the address bar says so", () => {
    expect(parseRoute("/horizon", "")).toEqual(surface("today"));
    expect(parseRoute("/horizon", "?task=t4")).toEqual(surface("today", "t4"));
    expect(parseRoute("/ventures/v1/today", "")).toEqual(surface("today"));
    expect(canonical(parseRoute("/horizon", ""), "/horizon", "")).toBe("/today");
    expect(canonical(parseRoute("/ventures/v1/today", ""), "/ventures/v1/today", "")).toBe("/today");
    expect(canonical(parseRoute("/today", ""), "/today", "")).toBeNull();
  });

  it("opens a project and a task as pages of their own, inside their venture", () => {
    expect(parseRoute("/ventures/v1/projects/p1", "")).toEqual(projectPage("v1", "p1"));
    expect(parseRoute("/ventures/v1/projects/p1", "?task=t1")).toEqual(projectPage("v1", "p1", "t1"));
    expect(parseRoute("/ventures/v1/tasks/t1", "")).toEqual(taskPage("v1", "t1"));
    // A tab without an item is still the tab.
    expect(parseRoute("/ventures/v1/projects", "")).toEqual(venture("v1", "projects"));
    expect(projectPage("v1", "p1").tab).toBe("projects");
    expect(taskPage("v1", "t1").tab).toBe("board");
  });

  it("keeps every path from before the rebuild landing somewhere real (decision 4)", () => {
    // With a venture it works as before.
    expect(parseRoute("/board/v1", "?task=t3")).toEqual(venture("v1", "board", "t3"));
    // Without one, the map. Nothing 404s.
    expect(parseRoute("/board", "")).toEqual(HOME);
    expect(parseRoute("/space", "")).toEqual(HOME);
    expect(parseRoute("/tree", "")).toEqual(HOME);
    expect(parseRoute("/ventures", "")).toEqual(HOME);
    expect(parseRoute("/nonsense/deep", "")).toEqual(HOME);
  });

  it("rewrites an old path to the one it resolved to, and leaves a current one alone", () => {
    expect(canonical(parseRoute("/board/v1", ""), "/board/v1", "")).toBe("/ventures/v1/board");
    expect(canonical(parseRoute("/space", "?task=t1"), "/space", "?task=t1")).toBe("/?task=t1");
    expect(canonical(parseRoute("/ventures/v1", ""), "/ventures/v1", "")).toBe("/ventures/v1/board");
    expect(canonical(parseRoute("/ventures/v1/board", ""), "/ventures/v1/board", "")).toBeNull();
    expect(canonical(parseRoute("/", ""), "/", "")).toBeNull();
    expect(canonical(parseRoute("/archive", "?task=t2"), "/archive", "?task=t2")).toBeNull();
  });

  it("writes back exactly the route it reads", () => {
    const routes = [
      HOME, surface("today"), surface("today", "t3"), surface("add"), surface("search"), surface("archive"), surface("account", "t 2"),
      venture("v/1", "board"), venture("v1", "board", "t1"), venture("v1", "projects"),
      projectPage("v1", "p 1"), projectPage("v1", "p1", "t2"), taskPage("v1", "t/1"),
    ];
    for (const r of routes) {
      const href = routeHref(r);
      const [path = "", query] = href.split("?");
      expect(parseRoute(path, query === undefined ? "" : `?${query}`), href).toEqual(r);
    }
  });

});

/**
 * The same table in both modes. In hash mode the address is `/try/#/today`: the path never
 * moves, and the route is the hash read as a path.
 */
describe("the router, in path and hash mode", () => {
  const table = [
    HOME, surface("map", "t1"), surface("today"), surface("today", "t3"), surface("add"), surface("search"),
    surface("archive"), surface("review"), surface("account", "t 2"),
    venture("v/1", "board"), venture("v1", "board", "t1"), venture("v1", "projects"), venture("v1", "projects", "t5"),
    projectPage("v1", "p 1"), projectPage("v1", "p1", "t2"), taskPage("v1", "t/1"),
  ];

  const split = (href: string): { pathname: string; search: string } => {
    const q = href.indexOf("?");
    return { pathname: q < 0 ? href : href.slice(0, q), search: q < 0 ? "" : href.slice(q) };
  };

  it("writes every route in the table so the same mode reads it back", () => {
    for (const mode of ["path", "hash"] as const) {
      for (const r of table) {
        const href = routeHref(r, mode);
        if (mode === "hash") expect(href.startsWith("#/"), href).toBe(true);
        const { pathname, search } = split(mode === "hash" ? href.slice(1) : href);
        expect(parseRoute(pathname, search), `${mode} ${href}`).toEqual(r);
        // The bar already says it, in either mode.
        expect(canonical(r, pathname, search, mode), `${mode} ${href}`).toBeNull();
      }
    }
  });

  it("writes the hash form as # then the path form", () => {
    expect(routeHref(surface("today"), "hash")).toBe("#/today");
    expect(routeHref(HOME, "hash")).toBe("#/");
    expect(routeHref(surface("today", "t3"), "hash")).toBe("#/today?task=t3");
    expect(routeHref(surface("today"), "path")).toBe("/today");
  });

  it("rewrites an old link in the form of the mode it is in", () => {
    expect(canonical(parseRoute("/horizon", ""), "/horizon", "", "hash")).toBe("#/today");
    expect(canonical(parseRoute("/horizon", ""), "/horizon", "", "path")).toBe("/today");
    expect(canonical(parseRoute("/space", "?task=t1"), "/space", "?task=t1", "hash")).toBe("#/?task=t1");
  });
});

describe("the router against a page, in hash mode", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  /** A page at `/try/`, with a history that moves the hash the way a browser does. */
  function page(pathname: string, hash: string) {
    const events = new EventTarget();
    const location = { pathname, search: "", hash };
    const move = (_state: unknown, _title: string, url: string): void => {
      if (url.startsWith("#")) location.hash = url;
    };
    const history = { state: null as unknown, pushState: vi.fn(move), replaceState: vi.fn(move) };
    vi.stubGlobal("window", {
      location, history,
      addEventListener: events.addEventListener.bind(events),
      removeEventListener: events.removeEventListener.bind(events),
      dispatchEvent: events.dispatchEvent.bind(events),
    });
    return { events, location, history };
  }

  it("lands on Today on a refresh of /try/#/today, with the path left alone", async () => {
    const { location } = page("/try/", "#/today");
    const router = await import("./router.js");
    const here = router.routeAddress("hash");
    expect(here).toEqual({ pathname: "/today", search: "" });
    expect(router.parseRoute(here.pathname, here.search)).toEqual(surface("today"));
    expect(router.currentHref("hash")).toBe("#/today");
    expect(location.pathname).toBe("/try/");
  });

  it("reads an empty hash as the map and a task in the hash as the sheet", async () => {
    const { location } = page("/try/", "");
    const router = await import("./router.js");
    expect(router.routeAddress("hash")).toEqual({ pathname: "/", search: "" });
    expect(router.currentHref("hash")).toBe("#/");
    location.hash = "#/today?task=t9";
    expect(router.routeAddress("hash")).toEqual({ pathname: "/today", search: "?task=t9" });
  });

  it("opens Today on a bare /try/ when Open on says Today, and leaves a route in the hash alone", async () => {
    const { location } = page("/try/", "");
    const router = await import("./router.js");
    const { openOnPlace } = await import("./appearance.js");
    const at = router.routeAddress("hash");
    expect(openOnPlace(at.pathname, at.search, "today")).toBe("today");
    expect(openOnPlace(at.pathname, at.search, "map")).toBeNull();
    location.hash = "#/archive";
    const deep = router.routeAddress("hash");
    expect(openOnPlace(deep.pathname, deep.search, "today")).toBeNull();
  });

  it("navigates by writing the hash, never the path, and a hashchange reaches a listener", async () => {
    const { events, location, history } = page("/try/", "");
    const router = await import("./router.js");
    router.navigate(surface("archive"));
    expect(history.pushState).toHaveBeenCalledWith(null, "", "#/archive");
    expect(location.pathname).toBe("/try/");
    expect(router.currentHref("hash")).toBe("#/archive");
    // Going where it already is does nothing.
    router.navigate(surface("archive"));
    expect(history.pushState).toHaveBeenCalledTimes(1);
    router.navigate(surface("search"), { replace: true });
    expect(history.replaceState).toHaveBeenCalledWith(null, "", "#/search");
    // A hand-edited hash, or Back across hash entries, re-reads the route.
    const listener = vi.fn();
    const stop = router.subscribe(listener);
    events.dispatchEvent(new Event("hashchange"));
    expect(listener).toHaveBeenCalledTimes(1);
    stop();
    events.dispatchEvent(new Event("hashchange"));
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
