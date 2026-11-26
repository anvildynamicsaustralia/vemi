import { describe, expect, it } from "vitest";
import { keysFrom, makeAccountKey, sameKey } from "./accountKey.js";
import { fromBase64Url, toBase64Url } from "./bytes.js";
import { CryptoError } from "./envelope.js";
import { openFromPairing, pairingKeys, pairingPublic, sealForPairing } from "./pairing.js";

describe("pairing a new device", () => {
  it("gives a raw P-256 public part in base64url", async () => {
    const text = await pairingPublic(await pairingKeys());
    const raw = fromBase64Url(text);
    expect(raw).toHaveLength(65);
    expect(raw?.[0]).toBe(4);
  });

  it("carries the account key from one device to another", async () => {
    const accountKey = makeAccountKey();
    const newDevice = await pairingKeys();
    const sealed = await sealForPairing(accountKey, await pairingPublic(newDevice), "pair-1");
    const opened = await openFromPairing(newDevice, sealed, "pair-1");
    expect(opened).toEqual(accountKey);
    expect(await sameKey(opened, (await keysFrom(accountKey)).keyCheck)).toBe(true);
  });

  it("seals differently every time", async () => {
    const newDevice = await pairingKeys();
    const key = makeAccountKey();
    const mine = await pairingPublic(newDevice);
    expect(await sealForPairing(key, mine, "p")).not.toBe(await sealForPairing(key, mine, "p"));
  });

  it("refuses a pairing opened with the wrong pairing id", async () => {
    const newDevice = await pairingKeys();
    const sealed = await sealForPairing(makeAccountKey(), await pairingPublic(newDevice), "pair-1");
    await expect(openFromPairing(newDevice, sealed, "pair-2")).rejects.toBeInstanceOf(CryptoError);
  });

  it("refuses a different device's key pair", async () => {
    const newDevice = await pairingKeys();
    const sealed = await sealForPairing(makeAccountKey(), await pairingPublic(newDevice), "pair-1");
    await expect(openFromPairing(await pairingKeys(), sealed, "pair-1")).rejects.toBeInstanceOf(CryptoError);
  });

  it("refuses one changed byte and malformed text", async () => {
    const newDevice = await pairingKeys();
    const sealed = await sealForPairing(makeAccountKey(), await pairingPublic(newDevice), "pair-1");
    const parts = sealed.split(".");
    for (const at of [1, 2]) {
      const bytes = fromBase64Url(parts[at] ?? "");
      if (!bytes) throw new Error("not base64url");
      bytes[0] = (bytes[0] ?? 0) ^ 1;
      const changed = parts.map((part, i) => (i === at ? toBase64Url(bytes) : part)).join(".");
      await expect(openFromPairing(newDevice, changed, "pair-1")).rejects.toBeInstanceOf(CryptoError);
    }
    await expect(openFromPairing(newDevice, "nonsense", "pair-1")).rejects.toBeInstanceOf(CryptoError);
  });

  it("refuses a public part that is not a P-256 point", async () => {
    const key = makeAccountKey();
    await expect(sealForPairing(key, "AAAA", "p")).rejects.toBeInstanceOf(CryptoError);
    await expect(sealForPairing(key, toBase64Url(new Uint8Array(65).fill(4)), "p")).rejects.toBeInstanceOf(CryptoError);
  });
});
