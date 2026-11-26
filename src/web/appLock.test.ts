import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { APP_LOCK_OPTIONS, isLocked, lastSeen, lockedNow, markSeen, memoryLockStore, onAppLockChange, readAppLock, writeAppLock } from "./appLock.js";

const MIN = 60_000;

describe("isLocked", () => {
  it("never covers when off", () => {
    expect(isLocked("off", null, 5)).toBe(false);
    expect(isLocked("off", 0, 10 * 3_600_000)).toBe(false);
  });
  it("covers once the chosen time away has passed", () => {
    expect(isLocked("1m", 1000, 1000 + MIN - 1)).toBe(false);
    expect(isLocked("1m", 1000, 1000 + MIN)).toBe(true);
    expect(isLocked("5m", 1000, 1000 + 4 * MIN)).toBe(false);
    expect(isLocked("5m", 1000, 1000 + 5 * MIN)).toBe(true);
    expect(isLocked("1h", 1000, 1000 + 59 * MIN)).toBe(false);
    expect(isLocked("1h", 1000, 1000 + 60 * MIN)).toBe(true);
  });
  it("covers a page never seen or seen in the future", () => {
    expect(isLocked("1m", null, 5000)).toBe(true);
    expect(isLocked("1m", 9000, 5000)).toBe(true);
  });
});

describe("the setting on this device", () => {
  it("is off until chosen, per account", () => {
    const store = memoryLockStore();
    expect(readAppLock("a@x.test", store)).toBe("off");
    writeAppLock("a@x.test", "5m", 1000, store);
    expect(readAppLock("a@x.test", store)).toBe("5m");
    expect(readAppLock("b@x.test", store)).toBe("off");
  });
  it("ignores a kept value it does not know", () => {
    const store = memoryLockStore();
    store.set("vemi:appLock:v1:a@x.test", "forever");
    expect(readAppLock("a@x.test", store)).toBe("off");
  });
  it("offers off, 1 minute, 5 minutes and 1 hour", () => {
    expect(APP_LOCK_OPTIONS.map((o) => o.label)).toEqual(["Off", "1 minute", "5 minutes", "1 hour"]);
  });
  it("does not cover the page at the moment a time is chosen", () => {
    const store = memoryLockStore();
    writeAppLock("a@x.test", "1m", 10_000, store);
    expect(lockedNow("a@x.test", 10_000, store)).toBe(false);
  });
  it("tells listeners about a change", () => {
    const fn = vi.fn();
    const stop = onAppLockChange(fn);
    writeAppLock("a@x.test", "1m", 1, memoryLockStore());
    stop();
    writeAppLock("a@x.test", "1m", 1, memoryLockStore());
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe("with a fake clock", () => {
  it("covers on return after the time and on a cold open past it", () => {
    const store = memoryLockStore();
    let now = 1_000_000;
    writeAppLock("a@x.test", "1m", now, store);
    markSeen("a@x.test", now, store);
    now += 30_000;
    expect(lockedNow("a@x.test", now, store)).toBe(false);
    markSeen("a@x.test", now, store);
    now += 61_000;
    expect(lockedNow("a@x.test", now, store)).toBe(true);
    // Staying covered does not move the last time seen, so a reload is still covered.
    expect(lastSeen("a@x.test", store)).toBe(1_030_000);
    expect(lockedNow("a@x.test", now + 1, store)).toBe(true);
  });
});

describe("reminders", () => {
  it("leaves the service worker with no reference to the app lock", () => {
    const sw = readFileSync(fileURLToPath(new URL("./sw.js", import.meta.url)), "utf8");
    expect(sw).not.toMatch(/app[-_ ]?lock/i);
  });
});
