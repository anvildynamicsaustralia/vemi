import { describe, expect, it } from "vitest";
import { crumbsFor } from "./crumbs.js";
import { HOME, parseRoute, venture } from "./router.js";

const tabs = { board: "Board", projects: "Projects" } as const;
const labels = (route: string, v: string | null, item: string | null) => crumbsFor(parseRoute(route, ""), v, item, tabs).map((c) => c.label);

describe("where am I", () => {
  it("names a plain surface alone", () => {
    expect(labels("/today", null, null)).toEqual(["Today"]);
    expect(labels("/account", null, null)).toEqual(["Account"]);
    expect(labels("/", null, null)).toEqual(["Map"]);
  });
  it("reads Map, the space, its view", () => {
    expect(labels("/ventures/v1/projects", "Shed", null)).toEqual(["Map", "Shed", "Projects"]);
  });
  it("reads Map, the space, the project", () => {
    expect(labels("/ventures/v1/projects/p1", "Shed", "Roof")).toEqual(["Map", "Shed", "Roof"]);
  });
  it("leaves out a space it does not know yet, and falls back for an unnamed item", () => {
    expect(labels("/ventures/v1/tasks/t1", null, null)).toEqual(["Map", "Task"]);
  });
  it("links every step but the page itself", () => {
    const trail = crumbsFor(parseRoute("/ventures/v1/projects/p1", ""), "Shed", "Roof", tabs);
    expect(trail.map((c) => c.to)).toEqual([HOME, venture("v1", "projects"), null]);
  });
});
