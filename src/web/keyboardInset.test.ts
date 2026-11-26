import { describe, expect, it } from "vitest";
import { coveredBelow } from "./keyboardInset.js";

describe("coveredBelow", () => {
  it("is nothing with no keyboard up", () => {
    expect(coveredBelow(844, { height: 844, offsetTop: 0, scale: 1 })).toBe(0);
  });

  it("is the height of the keyboard when it is up", () => {
    expect(coveredBelow(844, { height: 508, offsetTop: 0, scale: 1 })).toBe(336);
  });

  it("leaves out what the browser scrolled off the top to show the field", () => {
    expect(coveredBelow(844, { height: 508, offsetTop: 120, scale: 1 })).toBe(216);
  });

  it("is whole pixels and never less than nothing", () => {
    expect(coveredBelow(844, { height: 507.6, offsetTop: 0, scale: 1 })).toBe(336);
    expect(coveredBelow(844, { height: 900, offsetTop: 0, scale: 1 })).toBe(0);
  });

  it("is nothing while the page is pinch-zoomed", () => {
    expect(coveredBelow(844, { height: 422, offsetTop: 200, scale: 2 })).toBe(0);
  });
});
