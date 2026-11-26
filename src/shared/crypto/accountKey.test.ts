import { describe, expect, it } from "vitest";
import { keysFrom, makeAccountKey, sameKey } from "./accountKey.js";
import { fromBase64Url } from "./bytes.js";
import { open, seal } from "./envelope.js";

describe("the account key", () => {
  it("is 32 random bytes", () => {
    const a = makeAccountKey();
    expect(a).toHaveLength(32);
    expect(a).not.toEqual(makeAccountKey());
  });

  it("gives the same values twice and different values for two keys", async () => {
    const key = makeAccountKey();
    const one = await keysFrom(key);
    const two = await keysFrom(key);
    expect(two.keyCheck).toBe(one.keyCheck);
    expect(two.keyRef).toBe(one.keyRef);
    const sealed = await seal(one.fieldKey, one.keyRef, "same field key", { record: "r", field: "f" });
    expect(await open(two.fieldKey, sealed, { record: "r", field: "f" })).toBe("same field key");

    const other = await keysFrom(makeAccountKey());
    expect(other.keyCheck).not.toBe(one.keyCheck);
    expect(other.keyRef).not.toBe(one.keyRef);
  });

  it("sizes the check and the ref, and keeps the field key unexportable", async () => {
    const keys = await keysFrom(makeAccountKey());
    expect(fromBase64Url(keys.keyCheck)).toHaveLength(16);
    expect(fromBase64Url(keys.keyRef)).toHaveLength(8);
    expect(keys.fieldKey.extractable).toBe(false);
    await expect(crypto.subtle.exportKey("raw", keys.fieldKey)).rejects.toThrow();
  });

  it("confirms only the key a check was made from", async () => {
    const key = makeAccountKey();
    const { keyCheck } = await keysFrom(key);
    expect(await sameKey(key, keyCheck)).toBe(true);
    expect(await sameKey(makeAccountKey(), keyCheck)).toBe(false);
    expect(await sameKey(key, "not a check")).toBe(false);
    expect(await sameKey(new Uint8Array(5), keyCheck)).toBe(false);
  });

  it("refuses a key of the wrong length", async () => {
    await expect(keysFrom(new Uint8Array(31))).rejects.toThrow(RangeError);
  });
});
