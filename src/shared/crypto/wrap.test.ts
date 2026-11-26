import { describe, expect, it } from "vitest";
import { keysFrom, makeAccountKey } from "./accountKey.js";
import { fromBase64Url, randomBytes, toBase64Url } from "./bytes.js";
import { CryptoError } from "./envelope.js";
import { makeRecoveryKey, recoveryWrappingKey } from "./recoveryKey.js";
import { makeVaultSalt, passwordWrappingKey } from "./vaultPassword.js";
import { passkeyWrappingKey, unwrapKey, wrapKey, type WrapKind } from "./wrap.js";

async function reasonOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return "none";
  } catch (error) {
    if (error instanceof CryptoError) return error.reason;
    throw error;
  }
}

async function wrappingFor(kind: WrapKind, secret: Uint8Array): Promise<CryptoKey> {
  if (kind === "passkey") return passkeyWrappingKey(secret);
  if (kind === "recovery") return recoveryWrappingKey(secret);
  return passwordWrappingKey("a vault password", secret, 10);
}

describe("wrapped copies", () => {
  for (const kind of ["passkey", "password", "recovery"] as const) {
    it(`round trips under a ${kind} wrapping key`, async () => {
      const accountKey = makeAccountKey();
      const { keyRef } = await keysFrom(accountKey);
      const secret = kind === "password" ? makeVaultSalt() : randomBytes(32);
      const wrapped = await wrapKey(await wrappingFor(kind, secret), accountKey, kind, keyRef);
      expect(wrapped).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
      expect(await unwrapKey(await wrappingFor(kind, secret), wrapped, kind, keyRef)).toEqual(accountKey);
    });
  }

  it("refuses a wrong wrapping key", async () => {
    const accountKey = makeAccountKey();
    const { keyRef } = await keysFrom(accountKey);
    const wrapped = await wrapKey(await passkeyWrappingKey(randomBytes(32)), accountKey, "passkey", keyRef);
    expect(await reasonOf(unwrapKey(await passkeyWrappingKey(randomBytes(32)), wrapped, "passkey", keyRef))).toBe("key");
  });

  it("refuses the wrong kind or the wrong key ref", async () => {
    const accountKey = makeAccountKey();
    const { keyRef } = await keysFrom(accountKey);
    const other = (await keysFrom(makeAccountKey())).keyRef;
    const prf = randomBytes(32);
    const wrapped = await wrapKey(await passkeyWrappingKey(prf), accountKey, "passkey", keyRef);
    expect(await reasonOf(unwrapKey(await passkeyWrappingKey(prf), wrapped, "recovery", keyRef))).toBe("key");
    expect(await reasonOf(unwrapKey(await passkeyWrappingKey(prf), wrapped, "passkey", other))).toBe("key");
  });

  it("refuses one changed byte and malformed text", async () => {
    const accountKey = makeAccountKey();
    const { keyRef } = await keysFrom(accountKey);
    const prf = randomBytes(32);
    const wrapped = await wrapKey(await passkeyWrappingKey(prf), accountKey, "passkey", keyRef);
    const [iv = "", data = ""] = wrapped.split(".");
    const flipped = fromBase64Url(data);
    if (!flipped) throw new Error("not base64url");
    flipped[3] = (flipped[3] ?? 0) ^ 1;
    const key = await passkeyWrappingKey(prf);
    expect(await reasonOf(unwrapKey(key, `${iv}.${toBase64Url(flipped)}`, "passkey", keyRef))).toBe("key");
    expect(await reasonOf(unwrapKey(key, "nonsense", "passkey", keyRef))).toBe("damaged");
    expect(await reasonOf(unwrapKey(key, `${iv}.`, "passkey", keyRef))).toBe("key");
  });

  it("gives a different wrapped copy every time", async () => {
    const accountKey = makeAccountKey();
    const { keyRef } = await keysFrom(accountKey);
    const key = await passkeyWrappingKey(randomBytes(32));
    expect(await wrapKey(key, accountKey, "passkey", keyRef)).not.toBe(await wrapKey(key, accountKey, "passkey", keyRef));
  });

  it("gives different wrapping keys for different passkey outputs", async () => {
    const accountKey = makeAccountKey();
    const { keyRef } = await keysFrom(accountKey);
    const wrapped = await wrapKey(await passkeyWrappingKey(new Uint8Array(32)), accountKey, "passkey", keyRef);
    const wrong = await passkeyWrappingKey(new Uint8Array(32).fill(1));
    expect(await reasonOf(unwrapKey(wrong, wrapped, "passkey", keyRef))).toBe("key");
  });

  it("makes recovery keys that wrap", async () => {
    const accountKey = makeAccountKey();
    const { keyRef } = await keysFrom(accountKey);
    const recovery = makeRecoveryKey();
    const wrapped = await wrapKey(await recoveryWrappingKey(recovery), accountKey, "recovery", keyRef);
    expect(await unwrapKey(await recoveryWrappingKey(recovery), wrapped, "recovery", keyRef)).toEqual(accountKey);
  });
});
