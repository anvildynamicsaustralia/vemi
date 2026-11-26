import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SIGN_IN_TITLE, titleFor } from "./pageTitle.js";
import { projectPage, surface, taskPage, venture } from "./router.js";

describe("titleFor", () => {
  it("names each surface that is not a venture's", () => {
    expect(titleFor(surface("map"), null)).toBe("Map · VEMI");
    expect(titleFor(surface("today"), null)).toBe("Today · VEMI");
    expect(titleFor(surface("add"), null)).toBe("Add · VEMI");
    expect(titleFor(surface("search"), null)).toBe("Search · VEMI");
    expect(titleFor(surface("archive"), null)).toBe("Archive · VEMI");
    expect(titleFor(surface("account"), null)).toBe("Account · VEMI");
  });

  it("says the venture's own name first, then which of its surfaces", () => {
    expect(titleFor(venture("v1", "board"), "The Farm")).toBe("The Farm · Board · VEMI");
    expect(titleFor(venture("v1", "projects"), "The Farm")).toBe("The Farm · Projects · VEMI");
  });

  it("names a project's or task's own page by it, then its venture", () => {
    expect(titleFor(projectPage("v1", "p1"), "The Farm", "Fencing")).toBe("Fencing · The Farm · VEMI");
    expect(titleFor(taskPage("v1", "t1"), "The Farm", "Fix the gate")).toBe("Fix the gate · The Farm · VEMI");
    expect(titleFor(taskPage("v1", "t1"), null)).toBe("Task · VEMI");
  });

  it("falls back to the surface when the venture is not known yet", () => {
    expect(titleFor(venture("v1", "board"), null)).toBe("Board · VEMI");
  });

  it("ignores a venture name on a surface that is not about one venture", () => {
    expect(titleFor(surface("archive"), "The Farm")).toBe("Archive · VEMI");
  });

});

describe("the sign-in card's title", () => {
  // A fresh load shows index.html's title until the card draws; the card then sets its own,
  // so the tab reads the same whether it opened there or arrived from the map.
  it("is the name index.html loads with, and no surface's", () => {
    const html = readFileSync(new URL("../../index.html", import.meta.url), "utf8");
    expect(/<title>([^<]*)<\/title>/.exec(html)?.[1]).toBe(SIGN_IN_TITLE);
    expect(titleFor(surface("map"), null)).not.toBe(SIGN_IN_TITLE);
  });
});
