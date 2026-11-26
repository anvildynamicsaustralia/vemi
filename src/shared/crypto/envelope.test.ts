import { describe, expect, it } from "vitest";
import { keysFrom, makeAccountKey } from "./accountKey.js";
import { fromBase64Url, toBase64Url } from "./bytes.js";
import { CryptoError, envelopeKeyRef, open, reseal, seal, type CryptoFailure } from "./envelope.js";

const here = { record: "note-1", field: "body" };

async function setup() {
  const keys = await keysFrom(makeAccountKey());
  const envelope = await seal(keys.fieldKey, keys.keyRef, "a locked thought", here);
  return { keys, envelope };
}

async function reasonOf(promise: Promise<unknown>): Promise<CryptoFailure | "none"> {
  try {
    await promise;
    return "none";
  } catch (error) {
    if (error instanceof CryptoError) return error.reason;
    throw error;
  }
}

/** Flips one bit in one dot-separated part of an envelope. */
function change(envelope: string, part: number): string {
  const parts = envelope.split(".");
  const bytes = fromBase64Url(parts[part] ?? "");
  if (!bytes) throw new Error("part is not base64url");
  bytes[0] = (bytes[0] ?? 0) ^ 1;
  parts[part] = toBase64Url(bytes);
  return parts.join(".");
}

describe("the envelope", () => {
  it("has the v1 shape and round trips", async () => {
    const { keys, envelope } = await setup();
    const parts = envelope.split(".");
    expect(parts).toHaveLength(4);
    expect(parts[0]).toBe("v1");
    expect(parts[1]).toBe(keys.keyRef);
    expect(fromBase64Url(parts[2] ?? "")).toHaveLength(12);
    expect(await open(keys.fieldKey, envelope, here)).toBe("a locked thought");
    expect(await open(keys.fieldKey, envelope, { ...here, keyRef: keys.keyRef })).toBe("a locked thought");
  });

  it("uses a fresh IV for every write", async () => {
    const { keys, envelope } = await setup();
    const again = await seal(keys.fieldKey, keys.keyRef, "a locked thought", here);
    expect(again).not.toBe(envelope);
  });

  it("round trips empty and non-Latin text", async () => {
    const { keys } = await setup();
    for (const text of ["", "café 日本語 \u{1f512}"]) {
      const sealed = await seal(keys.fieldKey, keys.keyRef, text, here);
      expect(await open(keys.fieldKey, sealed, here)).toBe(text);
    }
  });

  it("names the key that sealed it", async () => {
    const { keys, envelope } = await setup();
    expect(envelopeKeyRef(envelope)).toBe(keys.keyRef);
  });

  it("refuses a wrong key", async () => {
    const { envelope } = await setup();
    const other = await keysFrom(makeAccountKey());
    expect(await reasonOf(open(other.fieldKey, envelope, here))).toBe("binding");
    expect(await reasonOf(open(other.fieldKey, envelope, { ...here, keyRef: other.keyRef }))).toBe("key");
  });

  it("refuses one changed byte in the IV, the ciphertext or the key ref", async () => {
    const { keys, envelope } = await setup();
    expect(await reasonOf(open(keys.fieldKey, change(envelope, 2), here))).toBe("binding");
    expect(await reasonOf(open(keys.fieldKey, change(envelope, 3), here))).toBe("binding");
    expect(await reasonOf(open(keys.fieldKey, change(envelope, 1), here))).toBe("binding");
    expect(await reasonOf(open(keys.fieldKey, change(envelope, 1), { ...here, keyRef: keys.keyRef }))).toBe("key");
  });

  it("refuses a swapped field or a swapped record", async () => {
    const { keys, envelope } = await setup();
    expect(await reasonOf(open(keys.fieldKey, envelope, { record: "note-1", field: "title" }))).toBe("binding");
    expect(await reasonOf(open(keys.fieldKey, envelope, { record: "note-2", field: "body" }))).toBe("binding");
  });

  it("refuses other versions by name, and malformed text as damaged", async () => {
    const { keys, envelope } = await setup();
    const rest = envelope.slice(envelope.indexOf("."));
    expect(await reasonOf(open(keys.fieldKey, `v0${rest}`, here))).toBe("version");
    expect(await reasonOf(open(keys.fieldKey, `v2${rest}`, here))).toBe("version");
    expect(await reasonOf(open(keys.fieldKey, "", here))).toBe("damaged");
    expect(await reasonOf(open(keys.fieldKey, "plain text", here))).toBe("damaged");
    expect(await reasonOf(open(keys.fieldKey, "v1.a.b", here))).toBe("damaged");
    expect(await reasonOf(open(keys.fieldKey, envelope.replace(/\.[^.]*$/, ".AAAA"), here))).toBe("damaged");
    expect(() => envelopeKeyRef(`v2${rest}`)).toThrow(CryptoError);
  });

  it("moves to a new record on the device", async () => {
    const { keys, envelope } = await setup();
    const to = { record: "note-9", field: "body" };
    const moved = await reseal(keys.fieldKey, envelope, here, to);
    expect(moved).not.toBe(envelope);
    expect(envelopeKeyRef(moved)).toBe(keys.keyRef);
    expect(await open(keys.fieldKey, moved, to)).toBe("a locked thought");
    expect(await reasonOf(open(keys.fieldKey, moved, here))).toBe("binding");
  });

  it("will not reseal from the wrong place", async () => {
    const { keys, envelope } = await setup();
    expect(await reasonOf(reseal(keys.fieldKey, envelope, { record: "other", field: "body" }, here))).toBe("binding");
  });
});
