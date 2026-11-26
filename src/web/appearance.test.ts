import { describe, expect, it } from "vitest";
import { DEFAULT_APPEARANCE } from "@vemi/shared";
import { paths, setAccountZone, zoneQuery } from "./api.js";
import { merged, openOnPlace, readAppearance, readStartOn, readZone, resolveTheme, startingAppearance, storedAppearance, storedStartOn, toStored } from "./appearance.js";

describe("readAppearance", () => {
  it("is Ember, comfortable and match device for anything that is not an object", () => {
    expect(readAppearance(null)).toEqual(DEFAULT_APPEARANCE);
    expect(readAppearance("moss")).toEqual(DEFAULT_APPEARANCE);
    expect(DEFAULT_APPEARANCE).toEqual({ accent: "ember", spacing: "comfortable", theme: "system", mapStyle: "grid" });
  });

  it("takes each setting it knows and defaults each it does not", () => {
    expect(readAppearance({ accent: "violet", spacing: "compact", theme: "dark" }))
      .toEqual({ accent: "violet", spacing: "compact", theme: "dark", mapStyle: "grid" });
    expect(readAppearance({ accent: "teal", spacing: "compact", theme: "auto" }))
      .toEqual({ accent: "ember", spacing: "compact", theme: "system", mapStyle: "grid" });
    expect(readAppearance({ accent: "constructor" }).accent).toBe("ember");
  });
});

describe("resolveTheme", () => {
  it("follows the device only on match device", () => {
    expect(resolveTheme("system", true)).toBe("dark");
    expect(resolveTheme("system", false)).toBe("light");
    expect(resolveTheme("light", true)).toBe("light");
    expect(resolveTheme("dark", false)).toBe("dark");
  });
});

describe("startingAppearance", () => {
  it("starts light when nothing was ever kept, whatever the device prefers", () => {
    expect(startingAppearance(null)).toEqual({ ...DEFAULT_APPEARANCE, theme: "light" });
  });
  it("follows a kept choice, dark or match device, and the defaults for a kept copy it cannot read", () => {
    const dark = { accent: "ember", spacing: "comfortable", theme: "dark", mapStyle: "grid" } as const;
    expect(startingAppearance(toStored(dark)).theme).toBe("dark");
    expect(startingAppearance(toStored({ ...dark, theme: "system" })).theme).toBe("system");
    expect(startingAppearance("{not json")).toEqual(DEFAULT_APPEARANCE);
  });
});

describe("the copy kept on this device", () => {
  it("round-trips, and never throws on what it did not write", () => {
    const a = { accent: "rose", spacing: "compact", theme: "light", mapStyle: "canvas" } as const;
    expect(storedAppearance(toStored(a))).toEqual(a);
    expect(storedAppearance(null)).toEqual(DEFAULT_APPEARANCE);
    expect(storedAppearance("{not json")).toEqual(DEFAULT_APPEARANCE);
    expect(storedAppearance("[]")).toEqual(DEFAULT_APPEARANCE);
  });
});

describe("Open on", () => {
  it("is the map unless the account says today", () => {
    expect(readStartOn({ startOn: "today" })).toBe("today");
    expect(readStartOn({ startOn: "map" })).toBe("map");
    expect(readStartOn({ startOn: "inbox" })).toBe("map");
    expect(readStartOn(null)).toBe("map");
  });
  it("reads the kept copy without throwing", () => {
    expect(storedStartOn("today")).toBe("today");
    expect(storedStartOn(null)).toBe("map");
    expect(storedStartOn("{")).toBe("map");
  });
  it("opens today only on the bare address", () => {
    expect(openOnPlace("/", "", "today")).toBe("today");
    expect(openOnPlace("/", "", "map")).toBeNull();
    expect(openOnPlace("/", "?task=abc", "today")).toBeNull();
    expect(openOnPlace("/search", "", "today")).toBeNull();
    expect(openOnPlace("/map", "", "today")).toBeNull();
  });
});

describe("the account's zone", () => {
  it("is the name the account kept, else null", () => {
    expect(readZone({ timeZone: "Australia/Perth" })).toBe("Australia/Perth");
    expect(readZone({ timeZone: null })).toBeNull();
    expect(readZone({ timeZone: "" })).toBeNull();
    expect(readZone(undefined)).toBeNull();
  });
  it("is sent on the requests once known, and the device's again when cleared", () => {
    setAccountZone("Australia/Perth");
    expect(zoneQuery()).toBe("?tz=Australia%2FPerth");
    expect(paths.today).toBe("/api/today?tz=Australia%2FPerth");
    expect(paths.export).toBe("/api/export?tz=Australia%2FPerth");
    setAccountZone(null);
    expect(zoneQuery()).not.toContain("Perth");
  });
});

describe("merged", () => {
  it("changes only what was named", () => {
    expect(merged(DEFAULT_APPEARANCE, { spacing: "compact" })).toEqual({ accent: "ember", spacing: "compact", theme: "system", mapStyle: "grid" });
  });
});
