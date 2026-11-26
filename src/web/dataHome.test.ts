import { describe, expect, it } from "vitest";
import { dataHome } from "./dataHome.js";

const DASH = String.fromCharCode(0x2014);

describe("dataHome", () => {
  it("tells an invitee the person who invited them runs this copy, with no name", () => {
    expect(dataHome({ owner: false })).toBe(
      "This VEMI is run by the person who invited you. Anything you don't lock is stored on their Cloudflare space.",
    );
  });

  it("tells the owner it runs on their own Cloudflare space", () => {
    expect(dataHome({ owner: true })).toBe("This VEMI runs on your own Cloudflare space.");
  });

  it("answers the device-only line only when the local flag is passed", () => {
    expect(dataHome({ owner: true, local: true })).toBe("Kept on this device only.");
    expect(dataHome({ owner: false, local: true })).toBe("Kept on this device only.");
    expect(dataHome({ owner: false, local: false })).not.toContain("this device");
  });

  it("holds no em-dash", () => {
    for (const owner of [true, false]) expect(dataHome({ owner })).not.toContain(DASH);
  });
});
