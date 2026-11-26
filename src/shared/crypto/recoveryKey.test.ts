import { describe, expect, it } from "vitest";
import { CryptoError } from "./envelope.js";
import { formatRecoveryKey, makeRecoveryKey, parseRecoveryKey } from "./recoveryKey.js";

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

describe("the recovery key", () => {
  it("is 32 random bytes", () => {
    expect(makeRecoveryKey()).toHaveLength(32);
    expect(makeRecoveryKey()).not.toEqual(makeRecoveryKey());
  });

  it("is 14 groups of 4 in the Crockford alphabet", async () => {
    const text = await formatRecoveryKey(makeRecoveryKey());
    const groups = text.split("-");
    expect(groups).toHaveLength(14);
    for (const group of groups) expect(group).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}$/);
  });

  it("parses what it formats", async () => {
    for (let i = 0; i < 20; i += 1) {
      const bytes = makeRecoveryKey();
      expect(await parseRecoveryKey(await formatRecoveryKey(bytes))).toEqual(bytes);
    }
    const zeros = new Uint8Array(32);
    expect(await parseRecoveryKey(await formatRecoveryKey(zeros))).toEqual(zeros);
  });

  it("ignores case, spaces and dashes, and reads I and L as 1 and O as 0", async () => {
    const bytes = new Uint8Array(32).fill(0x11);
    const text = await formatRecoveryKey(bytes);
    expect(await parseRecoveryKey(text.toLowerCase())).toEqual(bytes);
    expect(await parseRecoveryKey(text.replace(/-/g, " "))).toEqual(bytes);
    expect(await parseRecoveryKey(text.replace(/-/g, ""))).toEqual(bytes);
    expect(await parseRecoveryKey(`  ${text}\n`)).toEqual(bytes);
    const zeros = new Uint8Array(32);
    const zeroText = await formatRecoveryKey(zeros);
    expect(await parseRecoveryKey(zeroText.replace(/0/g, "O"))).toEqual(zeros);
    expect(await parseRecoveryKey(text.replace(/1/g, "l"))).toEqual(bytes);
    expect(await parseRecoveryKey(text.replace(/1/g, "I"))).toEqual(bytes);
  });

  it("refuses a key with any one wrong character", async () => {
    const bytes = new Uint8Array(32).map((_, i) => (i * 37 + 11) & 255);
    const text = await formatRecoveryKey(bytes);
    for (let at = 0; at < text.length; at += 1) {
      const char = text[at] ?? "";
      if (char === "-") continue;
      const next = ALPHABET[(ALPHABET.indexOf(char) + 1) % 32] ?? "0";
      const typo = text.slice(0, at) + next + text.slice(at + 1);
      await expect(parseRecoveryKey(typo)).rejects.toBeInstanceOf(CryptoError);
    }
  });

  it("refuses the wrong length and characters outside the alphabet", async () => {
    const text = await formatRecoveryKey(makeRecoveryKey());
    await expect(parseRecoveryKey("")).rejects.toBeInstanceOf(CryptoError);
    await expect(parseRecoveryKey(text.slice(0, -1))).rejects.toBeInstanceOf(CryptoError);
    await expect(parseRecoveryKey(`${text}0`)).rejects.toBeInstanceOf(CryptoError);
    await expect(parseRecoveryKey(`U${text.slice(1)}`)).rejects.toBeInstanceOf(CryptoError);
  });

  it("refuses a key of the wrong size to format", async () => {
    await expect(formatRecoveryKey(new Uint8Array(31))).rejects.toThrow(RangeError);
  });
});
