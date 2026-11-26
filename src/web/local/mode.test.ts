import { afterEach, describe, expect, it, vi } from "vitest";
import { isLocalPath } from "./mode.js";

describe("isLocalPath", () => {
  it("is local at /try and under it, and nowhere else", () => {
    for (const path of ["/try", "/try/", "/try/index.html", "/try/anything/else"]) expect(isLocalPath(path), path).toBe(true);
    for (const path of ["/", "/today", "/trying", "/try-it", "/get/try", "/ventures/try", ""]) expect(isLocalPath(path), path).toBe(false);
  });
});

describe("the mode, decided once", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  async function load(pathname: string) {
    vi.resetModules();
    vi.stubGlobal("window", { location: { pathname } });
    return import("./mode.js");
  }

  it("reads the page's own path on first ask and keeps the answer", async () => {
    const mode = await load("/try/");
    expect(mode.isLocal()).toBe(true);
    expect(mode.routeMode()).toBe("hash");
    // A later change of path (an auth link is rewritten to "/") does not flip the mode.
    vi.stubGlobal("window", { location: { pathname: "/" } });
    expect(mode.isLocal()).toBe(true);
  });

  it("is the path router everywhere but /try", async () => {
    const mode = await load("/today");
    expect(mode.isLocal()).toBe(false);
    expect(mode.routeMode()).toBe("path");
  });

  it("is the path router when there is no window at all", async () => {
    vi.resetModules();
    vi.stubGlobal("window", undefined);
    const mode = await import("./mode.js");
    expect(mode.isLocal()).toBe(false);
  });
});
