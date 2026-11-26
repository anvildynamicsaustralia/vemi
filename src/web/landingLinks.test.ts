import { describe, expect, it } from "vitest";
import { LANDING_FLAGS, LANDING_SHOTS, landingLinks, showsLanding } from "./landingLinks.js";

describe("landingLinks", () => {
  it("shows Try it now, Get my own VEMI at the front's address, and On GitHub", () => {
    expect(LANDING_FLAGS).toEqual({ tryShipped: true, getUrl: "https://vemi.anvildynamics.com.au", repoUrl: "https://github.com/anvildynamicsaustralia/vemi" });
    expect(landingLinks()).toEqual([
      { label: "Try it now", href: "/try" },
      { label: "Get my own VEMI", href: "https://vemi.anvildynamics.com.au/get/" },
      { label: "On GitHub", href: "https://github.com/anvildynamicsaustralia/vemi" },
    ]);
  });

  it("links Get my own VEMI to the front's absolute address, never a path on this copy", () => {
    const links = landingLinks({ tryShipped: false, getUrl: "https://get.example.test/", repoUrl: null });
    expect(links).toEqual([{ label: "Get my own VEMI", href: "https://get.example.test/get/" }]);
    for (const link of landingLinks({ tryShipped: true, getUrl: "https://get.example.test", repoUrl: null })) {
      if (link.label === "Get my own VEMI") expect(link.href).toBe("https://get.example.test/get/");
    }
    expect(landingLinks({ tryShipped: false, getUrl: "/get", repoUrl: null })).toEqual([]);
    expect(landingLinks({ tryShipped: false, getUrl: "", repoUrl: null })).toEqual([]);
  });

  it("shows each link only when its target exists", () => {
    expect(landingLinks({ tryShipped: true, getUrl: null, repoUrl: null })).toEqual([{ label: "Try it now", href: "/try" }]);
    expect(landingLinks({ tryShipped: true, getUrl: "https://get.example.test", repoUrl: "https://github.com/x/y" }).map((l) => l.label))
      .toEqual(["Try it now", "Get my own VEMI", "On GitHub"]);
    expect(landingLinks({ tryShipped: false, getUrl: null, repoUrl: "" })).toEqual([]);
  });

  it("describes every picture", () => {
    expect(LANDING_SHOTS).toHaveLength(8);
    expect(LANDING_SHOTS.filter((s) => s.device === "desk").map((s) => s.id)).toEqual(["today", "map", "project", "search"]);
    expect(LANDING_SHOTS.filter((s) => s.device === "phone").map((s) => s.id)).toEqual(["today", "map", "project", "account"]);
    for (const shot of LANDING_SHOTS) {
      expect(shot.alt.length).toBeGreaterThan(10);
      expect(shot.src.startsWith("/landing/")).toBe(true);
    }
  });
});

describe("showsLanding", () => {
  const base = { pathname: "/", hasLink: false, landing: true as boolean | null, choseSignIn: false };
  it("shows at / with the page on", () => expect(showsLanding(base)).toBe(true));
  it("not with the page off", () => expect(showsLanding({ ...base, landing: false })).toBe(false));
  it("not while the setting is unknown", () => expect(showsLanding({ ...base, landing: null })).toBe(false));
  it("not on any other path", () => {
    for (const pathname of ["/today", "/reset", "/invite", "/connect", "/map"]) expect(showsLanding({ ...base, pathname })).toBe(false);
  });
  it("not when a link was opened", () => expect(showsLanding({ ...base, hasLink: true })).toBe(false));
  it("not after Sign in was chosen", () => expect(showsLanding({ ...base, choseSignIn: true })).toBe(false));
});
