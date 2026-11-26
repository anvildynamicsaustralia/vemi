import { describe, expect, it } from "vitest";
import { keysFrom, makeAccountKey } from "./accountKey.js";
import { CryptoError } from "./envelope.js";
import { VAULT_ITERATIONS, makeVaultSalt, passwordWrappingKey } from "./vaultPassword.js";
import { unwrapKey, wrapKey } from "./wrap.js";

describe("the vault password", () => {
  it("starts at 600,000 rounds with a 16-byte salt", () => {
    expect(VAULT_ITERATIONS).toBe(600_000);
    expect(makeVaultSalt()).toHaveLength(16);
    expect(makeVaultSalt()).not.toEqual(makeVaultSalt());
  });

  it("wraps and unwraps with the default rounds", async () => {
    const accountKey = makeAccountKey();
    const { keyRef } = await keysFrom(accountKey);
    const salt = makeVaultSalt();
    const wrapped = await wrapKey(await passwordWrappingKey("correct horse battery", salt), accountKey, "password", keyRef);
    const again = await passwordWrappingKey("correct horse battery", salt);
    expect(await unwrapKey(again, wrapped, "password", keyRef)).toEqual(accountKey);
  });

  it("refuses a wrong password, a wrong salt and a wrong round count", async () => {
    const accountKey = makeAccountKey();
    const { keyRef } = await keysFrom(accountKey);
    const salt = makeVaultSalt();
    const wrapped = await wrapKey(await passwordWrappingKey("right password", salt, 50), accountKey, "password", keyRef);
    for (const key of [
      await passwordWrappingKey("wrong password", salt, 50),
      await passwordWrappingKey("right password", makeVaultSalt(), 50),
      await passwordWrappingKey("right password", salt, 51),
    ]) {
      await expect(unwrapKey(key, wrapped, "password", keyRef)).rejects.toBeInstanceOf(CryptoError);
    }
  });

  it("treats the same text in two Unicode forms as one password", async () => {
    const accountKey = makeAccountKey();
    const { keyRef } = await keysFrom(accountKey);
    const salt = makeVaultSalt();
    const wrapped = await wrapKey(await passwordWrappingKey("café password", salt, 20), accountKey, "password", keyRef);
    const decomposed = await passwordWrappingKey("café password", salt, 20);
    expect(await unwrapKey(decomposed, wrapped, "password", keyRef)).toEqual(accountKey);
  });

  it("refuses a round count that is not a whole number", async () => {
    await expect(passwordWrappingKey("x", makeVaultSalt(), 0)).rejects.toThrow(RangeError);
    await expect(passwordWrappingKey("x", makeVaultSalt(), 1.5)).rejects.toThrow(RangeError);
  });
});
