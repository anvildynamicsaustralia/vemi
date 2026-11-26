import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT, walk } from "./walk.js";

/**
 * VEMI-002 decision 33, carried into VEMI-003 and VEMI-010: identity stays behind an
 * interface, so the mechanism is a few named files. The tailnet check is gone and so are
 * passkeys; replacing accounts again must touch these files and nothing else.
 */

const MECHANISM = /PBKDF2|accounts\.google\.com|oauth2\.googleapis\.com/;

/** Sending mail was removed (VEMI-013 account phase): no file may bring a mail binding back. */
const MAIL_BINDING = new RegExp(`\\b(${["send", "email"].join("_")}|Send${"Email"})\\b`);

const ALLOWED = new Set([
  "src/api/accountIdentity.ts",
  "src/api/password.ts",
  "src/api/google.ts",
  // What tests them.
  "src/api/accountIdentity.test.ts",
  "src/api/password.test.ts",
  "src/api/google.test.ts",
  // Derives the vault key that wraps the account key on a device. It is not sign-in.
  "src/shared/crypto/vaultPassword.ts",
  "src/shared/crypto/vaultPassword.test.ts",
]);

describe("the identity mechanism lives in a few files", () => {
  const files = walk("src", [".ts", ".tsx"]);

  it("finds source to scan", () => {
    expect(files).toContain("src/api/accountIdentity.ts");
  });

  it("is known to nothing but its implementation", () => {
    const hits = files.filter((f) => !ALLOWED.has(f) && MECHANISM.test(readFileSync(join(ROOT, f), "utf8")));
    expect(hits).toEqual([]);
  });

  it("names the vault password derivation in exactly one more source file, outside the Worker", () => {
    const vault = "src/shared/crypto/vaultPassword.ts";
    const hits = files.filter((f) => !f.startsWith("src/api/") && MECHANISM.test(readFileSync(join(ROOT, f), "utf8")));
    expect(hits).toEqual([vault]);
  });

  it("names no mail binding anywhere", () => {
    const hits = files.filter((f) => MAIL_BINDING.test(readFileSync(join(ROOT, f), "utf8")));
    expect(hits).toEqual([]);
  });

  it("keeps the interface from depending on the implementation", () => {
    const iface = readFileSync(join(ROOT, "src/api/identity.ts"), "utf8");
    expect(iface).not.toMatch(/from\s+["']\.\/accountIdentity/);
  });

  it("has no tailnet identity left anywhere", () => {
    const hits = files.filter((f) => /tailscale-user-login|tailnetIdentity/i.test(readFileSync(join(ROOT, f), "utf8")));
    expect(hits).toEqual([]);
  });
});
