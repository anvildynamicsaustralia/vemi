import { describe, expect, it } from "vitest";
import {
  base32Decode,
  base32Encode,
  hashCode,
  newCodes,
  newRecoveryCode,
  otpauthUri,
  totp,
  verifyTotp,
} from "./totp.js";

const ascii = (s: string) => new TextEncoder().encode(s);
// RFC 6238 appendix B, SHA-1, secret "12345678901234567890", 8 digits; we keep the last 6.
const SECRET = ascii("12345678901234567890");
const VECTORS: [number, string][] = [
  [59, "287082"],
  [1111111109, "081804"],
  [1111111111, "050471"],
  [1234567890, "005924"],
  [2000000000, "279037"],
  [20000000000, "353130"],
];

describe("base32", () => {
  it("matches the RFC 4648 vectors", () => {
    expect(base32Encode(ascii(""))).toBe("");
    expect(base32Encode(ascii("f"))).toBe("MY");
    expect(base32Encode(ascii("fo"))).toBe("MZXQ");
    expect(base32Encode(ascii("foo"))).toBe("MZXW6");
    expect(base32Encode(ascii("foob"))).toBe("MZXW6YQ");
    expect(base32Encode(ascii("fooba"))).toBe("MZXW6YTB");
    expect(base32Encode(ascii("foobar"))).toBe("MZXW6YTBOI");
  });

  it("decodes any case, with spaces, dashes and padding", () => {
    expect(base32Decode("mzxw 6ytb-oi======")).toEqual(ascii("foobar"));
    expect(base32Decode("")).toEqual(new Uint8Array());
  });

  it("refuses text outside the alphabet", () => {
    expect(base32Decode("MZXW1")).toBeNull();
    expect(base32Decode("MZ!W")).toBeNull();
  });

  it("round trips random bytes", () => {
    const bytes = crypto.getRandomValues(new Uint8Array(20));
    expect(base32Decode(base32Encode(bytes))).toEqual(bytes);
  });
});

describe("totp", () => {
  it.each(VECTORS)("passes the RFC 6238 vector at %i s", async (seconds, code) => {
    expect(await totp(SECRET, seconds * 1000)).toBe(code);
  });
});

describe("verifyTotp", () => {
  const at = 1111111109 * 1000;
  it("accepts the current step and one either side", async () => {
    expect(await verifyTotp(SECRET, await totp(SECRET, at), at)).toBe(true);
    expect(await verifyTotp(SECRET, await totp(SECRET, at - 30000), at)).toBe(true);
    expect(await verifyTotp(SECRET, await totp(SECRET, at + 30000), at)).toBe(true);
  });

  it("refuses two steps away, a wrong code and a malformed one", async () => {
    expect(await verifyTotp(SECRET, await totp(SECRET, at - 60000), at)).toBe(false);
    expect(await verifyTotp(SECRET, await totp(SECRET, at + 60000), at)).toBe(false);
    expect(await verifyTotp(SECRET, "000000", at)).toBe(false);
    expect(await verifyTotp(SECRET, "08180", at)).toBe(false);
    expect(await verifyTotp(SECRET, "abcdef", at)).toBe(false);
  });

  it("ignores a space in the middle of the typed code", async () => {
    expect(await verifyTotp(SECRET, "081 804", at)).toBe(true);
  });
});

describe("otpauthUri", () => {
  it("builds the standard link with the secret in base32", () => {
    expect(otpauthUri("andy@example.com", SECRET)).toBe(
      `otpauth://totp/VEMI:andy%40example.com?secret=${base32Encode(SECRET)}&issuer=VEMI&algorithm=SHA1&digits=6&period=30`,
    );
  });
});

describe("one-time codes", () => {
  it("makes n distinct codes in two groups, each with its SHA-256 hash", async () => {
    const codes = await newCodes(10);
    expect(codes).toHaveLength(10);
    expect(new Set(codes.map((c) => c.code)).size).toBe(10);
    for (const c of codes) {
      expect(c.code).toMatch(/^[A-Z2-7]{5}-[A-Z2-7]{5}$/);
      expect(c.hash).toMatch(/^[0-9a-f]{64}$/);
      expect(c.hash).toBe(await hashCode(c.code));
    }
  });

  it("makes a recovery code in five groups of five", async () => {
    const r = await newRecoveryCode();
    expect(r.code).toMatch(/^([A-Z2-7]{5}-){4}[A-Z2-7]{5}$/);
    expect(r.hash).toBe(await hashCode(r.code));
  });

  it("hashes the same however the code is typed", async () => {
    const [c] = await newCodes(1);
    const code = c!.code;
    expect(await hashCode(code.toLowerCase())).toBe(c!.hash);
    expect(await hashCode(code.replace("-", " "))).toBe(c!.hash);
    expect(await hashCode(code.replace("-", ""))).toBe(c!.hash);
  });

  it("is plain SHA-256 of the letters and digits", async () => {
    // printf ABCDE | sha256sum
    expect(await hashCode("abc-de")).toBe("f0393febe8baaa55e32f7be2a7cc180bf34e52137d99e056c817a9c07b8f239a");
  });
});
