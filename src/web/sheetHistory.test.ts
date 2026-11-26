import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HOME, navigate, surface, venture } from "./router.js";
import { holdEntry, leaveDeadEntry, onSheetEntry, releaseEntry, sheetsOn, steppedOff } from "./sheetHistory.js";

/**
 * Back and the sheets, over a stand-in `window` like `routerHistory.test.ts`'s: an entry list,
 * where the browser's Back is the step a real one takes later, after the microtask a closing
 * sheet waits for.
 */
interface Entry {
  readonly state: unknown;
  readonly href: string;
}

let entries: Entry[];
let at: number;
let backs: number;

function place(href: string): void {
  const url = new URL(href, "https://vemi.test");
  stand.location.pathname = url.pathname;
  stand.location.search = url.search;
}

const stand = {
  location: { pathname: "/", search: "" },
  history: {
    get state(): unknown {
      return entries[at]?.state ?? null;
    },
    pushState(state: unknown, _unused: string, href: string): void {
      entries = [...entries.slice(0, at + 1), { state, href }];
      at = entries.length - 1;
      place(href);
    },
    replaceState(state: unknown, _unused: string, href: string): void {
      entries[at] = { state, href };
      place(href);
    },
    back(): void {
      backs += 1;
      at -= 1;
      place(entries[at]?.href ?? "/");
    },
  },
  dispatchEvent(): boolean {
    return true;
  },
};

const settle = (): Promise<void> => new Promise((resolve) => queueMicrotask(resolve));

beforeEach(() => {
  entries = [{ state: null, href: "/horizon" }];
  at = 0;
  backs = 0;
  place("/horizon");
  (globalThis as { window?: unknown }).window = stand;
});

afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
});

describe("a sheet and Back", () => {
  it("opens on an entry of its own, at the address already shown", () => {
    holdEntry("a");
    expect(entries).toHaveLength(2);
    expect(entries[1]?.href).toBe("/horizon");
    expect(sheetsOn(stand.history.state)).toEqual(["a"]);
    expect(steppedOff("a")).toBe(false);
  });

  it("is stepped off by Back, and closing then steps back no further", async () => {
    holdEntry("a");
    stand.history.back();
    expect(steppedOff("a")).toBe(true);
    releaseEntry("a");
    await settle();
    expect(backs).toBe(1);
    expect(at).toBe(0);
  });

  it("spends its own entry when it closes another way", async () => {
    holdEntry("a");
    releaseEntry("a");
    await settle();
    expect(backs).toBe(1);
    expect(at).toBe(0);
  });

  it("keeps its entry when it is mounted again at once", async () => {
    holdEntry("a");
    releaseEntry("a");
    holdEntry("a");
    await settle();
    expect(backs).toBe(0);
    expect(entries).toHaveLength(2);
  });

  it("stacks a sheet opened over another, and Back closes the top one only", () => {
    holdEntry("a");
    holdEntry("b");
    expect(sheetsOn(stand.history.state)).toEqual(["a", "b"]);
    stand.history.back();
    expect(steppedOff("b")).toBe(true);
    expect(steppedOff("a")).toBe(false);
  });

  it("takes the entry of a sheet that closed as it opened, rather than stacking on it", async () => {
    holdEntry("menu");
    releaseEntry("menu");
    holdEntry("picker");
    await settle();
    expect(backs).toBe(0);
    expect(entries).toHaveLength(2);
    expect(sheetsOn(stand.history.state)).toEqual(["picker"]);
  });

  it("leaves a page opened from inside it on the sheet's entry, so Back goes to where the sheet opened", async () => {
    holdEntry("a");
    expect(onSheetEntry()).toBe(true);
    navigate(venture("v1", "board"));
    expect(entries).toHaveLength(2);
    expect(onSheetEntry()).toBe(false);
    releaseEntry("a");
    await settle();
    expect(backs).toBe(0);
    expect(stand.location.pathname).toBe("/ventures/v1/board");
    stand.history.back();
    expect(stand.location.pathname).toBe("/horizon");
  });

  it("steps off an entry that names a sheet not open, as after a reload with one open", () => {
    entries = [{ state: null, href: "/horizon" }, { state: { vemiSheets: ["gone"] }, href: "/horizon" }];
    at = 1;
    leaveDeadEntry();
    expect(backs).toBe(1);
    expect(at).toBe(0);
  });

  it("leaves an entry whose sheets are all open", () => {
    holdEntry("a");
    holdEntry("b");
    stand.history.back();
    leaveDeadEntry();
    expect(backs).toBe(1);
    expect(sheetsOn(stand.history.state)).toEqual(["a"]);
  });

  it("steps off a sheet that closed under the one above it, when Back reaches it", async () => {
    holdEntry("a");
    holdEntry("b");
    releaseEntry("a");
    await settle();
    expect(backs).toBe(0);
    stand.history.back();
    leaveDeadEntry();
    expect(backs).toBe(2);
    expect(at).toBe(0);
  });

  it("lets a sheet opened from the address take a dead entry over, leaving nothing to step off", () => {
    entries = [{ state: null, href: "/horizon" }, { state: { vemiSheets: ["before"] }, href: "/horizon" }];
    at = 1;
    holdEntry("after");
    expect(entries).toHaveLength(2);
    leaveDeadEntry();
    expect(backs).toBe(0);
    expect(sheetsOn(stand.history.state)).toEqual(["after"]);
  });

  it("leaves ordinary navigation pushing as it did", () => {
    navigate(surface("archive"));
    navigate(HOME);
    expect(entries).toHaveLength(3);
  });
});
