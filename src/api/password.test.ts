import { describe, expect, it } from "vitest";
import {
  PBKDF2_ITERATIONS,
  dummyVerify,
  hashPassword,
  needsRehash,
  passwordProblem,
  verifyPassword,
} from "./password.js";

const PW = "correct horse battery";

describe("hashPassword", () => {
  it("writes the scheme, the current count, a salt and a 32-byte hash", async () => {
    const stored = await hashPassword(PW);
    const [scheme, count, salt, hash, ...rest] = stored.split("$");
    expect(scheme).toBe("pbkdf2-sha256");
    expect(count).toBe(String(PBKDF2_ITERATIONS));
    expect(PBKDF2_ITERATIONS).toBe(100000);
    expect(salt).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(hash).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(Buffer.from(hash ?? "", "base64url")).toHaveLength(32);
    expect(rest).toEqual([]);
  });

  it("uses a fresh salt every time, so the same password never stores the same twice", async () => {
    const a = await hashPassword(PW);
    const b = await hashPassword(PW);
    expect(a.split("$")[2]).not.toBe(b.split("$")[2]);
    expect(a.split("$")[3]).not.toBe(b.split("$")[3]);
    expect(await verifyPassword(PW, a)).toBe(true);
    expect(await verifyPassword(PW, b)).toBe(true);
  });
});

describe("verifyPassword", () => {
  it("accepts the right password and refuses the wrong one", async () => {
    const stored = await hashPassword(PW);
    expect(await verifyPassword(PW, stored)).toBe(true);
    expect(await verifyPassword(PW + "x", stored)).toBe(false);
    expect(await verifyPassword("", stored)).toBe(false);
  });

  it("treats canonically equal text as the same password", async () => {
    const stored = await hashPassword("café au lait");
    expect(await verifyPassword("café au lait", stored)).toBe(true);
  });

  it("refuses a stored hash of the wrong length instead of comparing a prefix", async () => {
    const stored = await hashPassword(PW);
    const parts = stored.split("$");
    const hash = parts[3] ?? "";
    const shorter = [...parts.slice(0, 3), hash.slice(0, -4)].join("$");
    const longer = [...parts.slice(0, 3), hash + "AAAA"].join("$");
    expect(await verifyPassword(PW, shorter)).toBe(false);
    expect(await verifyPassword(PW, longer)).toBe(false);
  });

  it("never throws on a stored value that is not ours", async () => {
    for (const junk of [
      "",
      "plain",
      "pbkdf2-sha256$100000$onlysalt",
      "pbkdf2-sha256$abc$c2FsdA$aGFzaA",
      "pbkdf2-sha256$0$c2FsdA$aGFzaA",
      "pbkdf2-sha256$-5$c2FsdA$aGFzaA",
      "pbkdf2-sha256$100000$$",
      "pbkdf2-sha256$100000$!!!$???",
      "argon2$100000$c2FsdA$aGFzaA",
      "a$b$c$d$e",
    ]) {
      expect(await verifyPassword(PW, junk)).toBe(false);
    }
  });

  it("honours the count the hash was stored with", async () => {
    const stored = await hashPassword(PW);
    const parts = stored.split("$");
    parts[1] = "100001";
    expect(await verifyPassword(PW, parts.join("$"))).toBe(false);
  });
});

describe("needsRehash", () => {
  it("is false only for the current count", async () => {
    const stored = await hashPassword(PW);
    expect(needsRehash(stored)).toBe(false);
    const at = (n: string) => {
      const p = stored.split("$");
      p[1] = n;
      return p.join("$");
    };
    expect(needsRehash(at(String(PBKDF2_ITERATIONS - 1)))).toBe(true);
    expect(needsRehash(at(String(PBKDF2_ITERATIONS + 1)))).toBe(true);
    expect(needsRehash(at("600000"))).toBe(true);
    expect(needsRehash(at("1"))).toBe(true);
  });

  it("is true for anything it cannot read", () => {
    expect(needsRehash("")).toBe(true);
    expect(needsRehash("plain")).toBe(true);
    expect(needsRehash("pbkdf2-sha256$abc$c2FsdA$aGFzaA")).toBe(true);
  });
});

describe("dummyVerify", () => {
  it("does the work of a check and always says no", async () => {
    expect(await dummyVerify(PW)).toBe(false);
    expect(await dummyVerify("")).toBe(false);
  });
});

describe("passwordProblem", () => {
  it("lets 10 to 256 characters through", () => {
    expect(passwordProblem("a".repeat(10))).toBeNull();
    expect(passwordProblem("a".repeat(256))).toBeNull();
  });

  it("says why when too short or too long", () => {
    expect(passwordProblem("a".repeat(9))).toMatch(/at least 10/);
    expect(passwordProblem("a".repeat(257))).toMatch(/at most 256/);
    expect(passwordProblem("")).not.toBeNull();
  });

  it("counts after NFC and by character, not by code unit", () => {
    // nine letters plus e + combining acute is ten characters once composed
    expect(passwordProblem("a".repeat(9) + "é")).toBeNull();
    expect(passwordProblem("\u{1F600}".repeat(10))).toBeNull();
    expect(passwordProblem("\u{1F600}".repeat(9))).not.toBeNull();
  });
});
