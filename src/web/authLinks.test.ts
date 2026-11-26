import { describe, expect, it } from "vitest";
import { authLinkFrom, googleRefusal, googleSaid, signedInNotice } from "./authLinks.js";

const TOKEN = "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0U1v";

describe("a link from a mail", () => {
  it("reads the token out of the hash of each token page", () => {
    for (const kind of ["reset", "invite"] as const) {
      expect(authLinkFrom(`/${kind}`, `#${TOKEN}`)).toEqual({ kind, token: TOKEN });
    }
  });

  it("takes base64url's dash and underscore", () => {
    expect(authLinkFrom("/reset", "#a-b_c-d_e-f_g-h_i-j_k-l_")).toEqual({ kind: "reset", token: "a-b_c-d_e-f_g-h_i-j_k-l_" });
  });

  it("finds nothing on any other page, or in a hash that is not a token", () => {
    expect(authLinkFrom("/today", `#${TOKEN}`)).toBeNull();
    expect(authLinkFrom("/reset", "")).toBeNull();
    expect(authLinkFrom("/reset", "#")).toBeNull();
    expect(authLinkFrom("/reset", "#short")).toBeNull();
    expect(authLinkFrom("/invite", "#has spaces in it but is long enough")).toBeNull();
    expect(authLinkFrom("/elsewhere", "#%E0%A4%A")).toBeNull();
  });
});

describe("what Google sends back", () => {
  it("reads a refusal code from the hash of the home page", () => {
    expect(authLinkFrom("/", "#google=unknown")).toEqual({ kind: "google", code: "unknown" });
    expect(authLinkFrom("/today", "#google=unknown")).toBeNull();
    expect(authLinkFrom("/", "#google=")).toBeNull();
    expect(authLinkFrom("/", "#google=NOT-A-CODE")).toBeNull();
  });

  it("has a sentence for every refusal the Worker makes, and a plain one for any other", () => {
    for (const code of ["unavailable", "state", "denied", "failed", "taken", "invite", "other", "unknown"]) {
      expect(googleSaid(code).length).toBeGreaterThan(10);
    }
    expect(googleSaid("unknown")).toBe("No VEMI account uses that Google account.");
    expect(googleSaid("other")).toBe("The VEMI account for this email is linked to a different Google account. Use that one, or your password if you set one.");
    expect(googleSaid("somethingnew")).toBe(googleSaid("failed"));
  });

  it("shows a refusal on the sign-in card, and nothing for a sign-in that linked Google", () => {
    expect(googleRefusal({ kind: "google", code: "denied" })).toBe("Google sign-in was cancelled.");
    expect(googleRefusal({ kind: "google", code: "linked" })).toBeNull();
    expect(googleRefusal({ kind: "reset", token: TOKEN })).toBeNull();
    expect(googleRefusal(null)).toBeNull();
  });
});

describe("what a signed-in person is told on arrival", () => {
  it("passes a Google refusal on, so a refused link from the account panel is not dropped", () => {
    expect(signedInNotice({ kind: "google", code: "taken" })).toBe("That Google account already belongs to another VEMI account.");
  });

  it("says Google was linked, since a sign-in linked it to the account at its address without asking", () => {
    expect(signedInNotice({ kind: "google", code: "linked" })).toBe("Google is now linked to your account. Either way in works from now on.");
  });

  it("says nothing for a token page or no link at all", () => {
    expect(signedInNotice({ kind: "reset", token: TOKEN })).toBeNull();
    expect(signedInNotice(null)).toBeNull();
  });
});
