import { describe, expect, it } from "vitest";
import { discardsWaiting } from "./signOutWords.js";

describe("discardsWaiting", () => {
  it("says how many changes signing out discards, in the right number", () => {
    expect(discardsWaiting(1)).toBe("1 change made on this device has not sent yet. Signing out discards it.");
    expect(discardsWaiting(3)).toBe("3 changes made on this device have not sent yet. Signing out discards them.");
  });
});
