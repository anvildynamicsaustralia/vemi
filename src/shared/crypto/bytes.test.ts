import { describe, expect, it } from "vitest";
import { equalBytes, fromBase64Url, fromUtf8, hkdf, randomBytes, toBase64Url, utf8 } from "./bytes.js";

describe("bytes", () => {
  it("round trips base64url for every length", () => {
    for (let n = 0; n < 40; n += 1) {
      const bytes = randomBytes(n);
      const text = toBase64Url(bytes);
      expect(text).toMatch(/^[A-Za-z0-9_-]*$/);
      expect(fromBase64Url(text)).toEqual(bytes);
    }
  });

  it("refuses text that is not base64url", () => {
    expect(fromBase64Url("a+b")).toBeNull();
    expect(fromBase64Url("ab=c")).toBeNull();
    expect(fromBase64Url("a")).toBeNull();
  });

  it("round trips text", () => {
    expect(fromUtf8(utf8("café \u{1f512}"))).toBe("café \u{1f512}");
  });

  it("compares bytes by value", () => {
    expect(equalBytes(utf8("ab"), utf8("ab"))).toBe(true);
    expect(equalBytes(utf8("ab"), utf8("ac"))).toBe(false);
    expect(equalBytes(utf8("ab"), utf8("abc"))).toBe(false);
  });

  it("separates HKDF outputs by label", async () => {
    const secret = utf8("a secret of some kind");
    expect(await hkdf(secret, "one", 16)).toEqual(await hkdf(secret, "one", 16));
    expect(await hkdf(secret, "one", 16)).not.toEqual(await hkdf(secret, "two", 16));
  });
});
