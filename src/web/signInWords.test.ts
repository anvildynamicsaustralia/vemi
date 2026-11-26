import { describe, expect, it } from "vitest";
import { AuthError, UNREACHABLE } from "./auth.js";
import { signInRefused } from "./signInWords.js";

const NO_MATCH = new AuthError(401, "That email and password don't match.");

describe("what the sign-in card says about a refused password", () => {
  it("names the ways in the card offers, and only those", () => {
    expect(signInRefused(NO_MATCH, { googleReady: true })).toBe(
      "That email and password don't match. If you joined with Google, use Continue with Google.",
    );
    expect(signInRefused(NO_MATCH, { googleReady: false })).toBe("That email and password don't match.");
  });

  it("never suggests a link to be sent", () => {
    for (const googleReady of [true, false]) {
      expect(signInRefused(NO_MATCH, { googleReady })).not.toMatch(/forgot/i);
      expect(signInRefused(new AuthError(429, "Too many tries. Wait 15 minutes and try again."), { googleReady })).not.toMatch(/forgot/i);
    }
  });

  it("adds Google to the limit's way out when the card offers it", () => {
    const limited = new AuthError(429, "Too many tries. Wait 15 minutes and try again.");
    expect(signInRefused(limited, { googleReady: true })).toBe(
      "Too many tries. Wait 15 minutes and try again. Continue with Google still works if your account uses it.",
    );
    expect(signInRefused(limited, { googleReady: false })).toBe(limited.message);
  });

  it("passes anything else on as it came", () => {
    const away = new AuthError(0, UNREACHABLE);
    expect(signInRefused(away, { googleReady: true })).toBe(UNREACHABLE);
    expect(signInRefused(new Error("plain"), { googleReady: true })).toBe("plain");
  });
});
