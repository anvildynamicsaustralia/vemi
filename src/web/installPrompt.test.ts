import { describe, expect, it } from "vitest";
import { installOffer, isIos } from "./installPrompt.js";

describe("isIos", () => {
  const phone = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1";
  const mac = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/17.4 Safari/605.1.15";

  it("sees an iPhone, and an iPad that says it is a Mac", () => {
    expect(isIos({ userAgent: phone, maxTouchPoints: 5 })).toBe(true);
    expect(isIos({ userAgent: mac, maxTouchPoints: 5 })).toBe(true);
  });

  it("does not take a real Mac for one", () => {
    expect(isIos({ userAgent: mac, maxTouchPoints: 0 })).toBe(false);
  });
});

describe("installOffer", () => {
  it("offers the browser's own install when it handed one over", () => {
    expect(installOffer({ promptReady: true, standalone: false, ios: false })).toBe("button");
  });

  it("offers Safari's two taps on an iPhone, which has no install event", () => {
    expect(installOffer({ promptReady: false, standalone: false, ios: true })).toBe("ios");
  });

  it("offers nothing once VEMI runs installed", () => {
    expect(installOffer({ promptReady: true, standalone: true, ios: false })).toBeNull();
    expect(installOffer({ promptReady: false, standalone: true, ios: true })).toBeNull();
  });

  it("offers nothing where the browser has no install to give", () => {
    expect(installOffer({ promptReady: false, standalone: false, ios: false })).toBeNull();
  });
});
