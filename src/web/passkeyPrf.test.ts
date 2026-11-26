import { describe, expect, it } from "vitest";
import { toBase64Url } from "@vemi/shared";
import { type MadeCredential, type PasskeyWorld, makePasskey, passkeyOutput, prfPossible } from "./passkeyPrf.js";

const ID = new Uint8Array([1, 2, 3, 4]);
const OUT = new Uint8Array(32).fill(9);

function credential(first?: Uint8Array, enabled?: boolean): MadeCredential {
  return {
    rawId: ID.buffer.slice(0) as ArrayBuffer,
    getClientExtensionResults: () => ({ prf: { enabled, results: first === undefined ? undefined : { first: first.buffer.slice(0) as ArrayBuffer } } }),
  };
}

function world(over: Partial<PasskeyWorld> = {}): PasskeyWorld & { readonly asked: { create: unknown[]; get: unknown[] } } {
  const asked = { create: [] as unknown[], get: [] as unknown[] };
  return {
    present: true,
    hostname: "localhost",
    create: async (o) => { asked.create.push(o); return credential(OUT); },
    get: async (o) => { asked.get.push(o); return credential(OUT); },
    ...over,
    asked,
  };
}

describe("a passkey used for its PRF output", () => {
  it("is possible only where WebAuthn is present", () => {
    expect(prfPossible(world())).toBe(true);
    expect(prfPossible(world({ present: false }))).toBe(false);
  });

  it("makes a passkey with the C16 options and returns the output from create", async () => {
    const w = world();
    const salt = new Uint8Array(32).fill(5);
    const made = await makePasskey({ email: "a@example.com", salt }, w);
    expect(made?.output).toEqual(OUT);
    expect(made?.credentialId).toBe(toBase64Url(ID));
    expect(w.asked.get).toHaveLength(0);
    const options = (w.asked.create[0] as { publicKey: Record<string, any> }).publicKey;
    expect(options.rp).toEqual({ id: "localhost", name: "VEMI" });
    expect(options.user.id).toHaveLength(16);
    expect(options.user.name).toBe("a@example.com");
    expect(options.user.displayName).toBe("VEMI");
    expect(options.authenticatorSelection).toEqual({ residentKey: "required", userVerification: "required" });
    expect(options.hints).toEqual(["client-device"]);
    expect(options.extensions.prf.eval.first).toEqual(salt);
  });

  it("asks get once when create gave no output", async () => {
    const w = world({ create: async () => credential(undefined, true) });
    const made = await makePasskey({ email: "a@example.com", salt: new Uint8Array(32) }, w);
    expect(made?.output).toEqual(OUT);
    expect(w.asked.get).toHaveLength(1);
  });

  it("returns null when the authenticator has no PRF", async () => {
    const w = world({ create: async () => credential(undefined, false) });
    expect(await makePasskey({ email: "a@example.com", salt: new Uint8Array(32) }, w)).toBeNull();
    const none = world({ create: async () => credential(undefined, undefined), get: async () => credential(undefined) });
    expect(await makePasskey({ email: "a@example.com", salt: new Uint8Array(32) }, none)).toBeNull();
  });

  it("returns null with no WebAuthn", async () => {
    expect(await makePasskey({ email: "a@example.com", salt: new Uint8Array(32) }, world({ present: false }))).toBeNull();
  });

  it("asks get with every credential and its own salt", async () => {
    const w = world();
    const rows = [
      { credentialId: toBase64Url(ID), salt: toBase64Url(new Uint8Array(32).fill(1)) },
      { credentialId: toBase64Url(new Uint8Array([7, 7])), salt: toBase64Url(new Uint8Array(32).fill(2)) },
    ];
    const got = await passkeyOutput(rows, w);
    expect(got?.credentialId).toBe(toBase64Url(ID));
    const options = (w.asked.get[0] as { publicKey: Record<string, any> }).publicKey;
    expect(options.allowCredentials).toHaveLength(2);
    expect(Object.keys(options.extensions.prf.evalByCredential)).toEqual(rows.map((r) => r.credentialId));
    expect(options.userVerification).toBe("required");
  });

  it("asks nothing when there are no rows", async () => {
    const w = world();
    expect(await passkeyOutput([], w)).toBeNull();
    expect(w.asked.get).toHaveLength(0);
  });
});
