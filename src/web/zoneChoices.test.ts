import { describe, expect, it } from "vitest";
import { browserZone, zoneChoices, zoneShown } from "./zoneChoices.js";

describe("the time zone picker", () => {
  it("shows the saved zone, else the browser's, else none", () => {
    expect(zoneShown("Australia/Perth", "Australia/Sydney")).toBe("Australia/Perth");
    expect(zoneShown(null, "Australia/Sydney")).toBe("Australia/Sydney");
    expect(zoneShown(null, null)).toBe("");
  });

  it("lists each zone once, sorted, with the shown one in even when this browser does not list it", () => {
    expect(zoneChoices(["Europe/Paris", "Australia/Sydney", "Europe/Paris"], "Pacific/Odd")).toEqual([
      "Australia/Sydney", "Europe/Paris", "Pacific/Odd",
    ]);
    expect(zoneChoices([], "")).toEqual([]);
  });

  it("reads the browser's own zone, or null when it names none", () => {
    const zone = browserZone();
    expect(zone === null || zone.length > 0).toBe(true);
  });
});
