import { describe, expect, it } from "vitest";
import { parseRoute, routeHref, surface, TABS } from "../router.js";
import { PHONE_BAR, PLACES, placeOf, RAIL } from "./Chrome.js";

/**
 * The rail and the router are two lists that have to agree: a rail row whose place the
 * router does not know lands on the map without saying so. Nothing but this holds them
 * together. The router knows six places; the rail and the bar show fewer, and the rest stay
 * reachable: Add from the bar's middle button, Archive from Account.
 */
function routeOf(place: (typeof PLACES)[number]) {
  return place === "map" ? parseRoute("/", "") : parseRoute(`/${place}`, "");
}

describe("the rail", () => {
  it("has one row for each of its places, all of them places the router knows", () => {
    const places = RAIL.map((r) => r.place);
    expect(new Set(places).size).toBe(places.length);
    for (const place of places) expect(PLACES, place).toContain(place);
  });

  it("reads Map, Today, Search, Account", () => {
    expect(RAIL.map((r) => r.label)).toEqual(["Map", "Today", "Search", "Account"]);
  });

  it("points Today at the today screen", () => {
    expect(RAIL.find((r) => r.label === "Today")?.place).toBe("today");
    expect(PHONE_BAR.find((r) => r.label === "Today")?.place).toBe("today");
    expect(TABS).toEqual(["board", "projects"]);
  });

  it("goes only to places the router knows, and lights the one it went to", () => {
    for (const { place } of RAIL) {
      const route = routeOf(place);
      expect(route.surface, place).toBe(place);
      expect(parseRoute(routeHref(surface(place)), ""), place).toEqual(route);
      expect(placeOf(route), place).toBe(place);
    }
  });
});

describe("the phone bar", () => {
  it("reads Map, Today, Add in the middle, Search, Account", () => {
    expect(PHONE_BAR.map((r) => r.label)).toEqual(["Map", "Today", "Add", "Search", "Account"]);
    expect(PHONE_BAR[2]?.place).toBe("add");
  });

  it("has the rail's four places and Add, and nothing else", () => {
    expect(PHONE_BAR.filter((r) => r.place !== "add")).toEqual(RAIL);
  });

  it("goes only to places the router knows", () => {
    for (const { place } of PHONE_BAR) expect(routeOf(place).surface, place).toBe(place);
  });
});

describe("what is not on the rail", () => {
  it("is still a place the router can go to", () => {
    for (const place of PLACES.filter((p) => !RAIL.some((r) => r.place === p))) {
      expect(routeOf(place).surface, place).toBe(place);
    }
  });
});
