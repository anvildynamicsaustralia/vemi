/**
 * A passkey used for its PRF output, which wraps the account key. No server checks the
 * assertion: the PRF output is what opens the wrapped copy, and only the right authenticator
 * can make it. `navigator.credentials` sits behind a small interface so tests can fake it.
 */
import { type Bytes, fromBase64Url, randomBytes, toBase64Url } from "@vemi/shared";

interface PrfResults {
  readonly enabled?: boolean;
  readonly results?: { readonly first?: ArrayBuffer | ArrayBufferView };
}

export interface MadeCredential {
  readonly rawId: ArrayBuffer;
  getClientExtensionResults(): { readonly prf?: PrfResults };
}

export interface PasskeyWorld {
  /** True where WebAuthn exists at all. */
  readonly present: boolean;
  readonly hostname: string;
  create(options: unknown): Promise<MadeCredential | null>;
  get(options: unknown): Promise<MadeCredential | null>;
}

export interface PasskeyOutput {
  /** base64url */
  readonly credentialId: string;
  readonly output: Bytes;
}

export interface PasskeyRowRef {
  readonly credentialId: string;
  readonly salt: string;
}

export function browserWorld(): PasskeyWorld {
  const has = typeof navigator !== "undefined" && "credentials" in navigator && typeof PublicKeyCredential !== "undefined";
  return {
    present: has,
    hostname: typeof location === "undefined" ? "" : location.hostname,
    create: (options) => (has ? navigator.credentials.create(options as CredentialCreationOptions) : Promise.resolve(null)) as Promise<MadeCredential | null>,
    get: (options) => (has ? navigator.credentials.get(options as CredentialRequestOptions) : Promise.resolve(null)) as Promise<MadeCredential | null>,
  };
}

/** True where a passkey can be asked for at all. Whether it has PRF is only known on use. */
export function prfPossible(world: PasskeyWorld = browserWorld()): boolean {
  return world.present;
}

function outputOf(credential: MadeCredential | null): PasskeyOutput | null {
  if (credential === null) return null;
  const first = credential.getClientExtensionResults().prf?.results?.first;
  if (first === undefined) return null;
  const bytes = first instanceof ArrayBuffer
    ? new Uint8Array(first)
    : new Uint8Array(first.buffer, first.byteOffset, first.byteLength);
  return { credentialId: toBase64Url(new Uint8Array(credential.rawId)), output: new Uint8Array(bytes) };
}

/**
 * Makes a passkey and returns what its PRF gave for `salt`. Some authenticators give the output
 * only on a later `get()`, so when `create()` returns none, one `get()` is asked. Null when the
 * authenticator has no PRF at all.
 */
export async function makePasskey(
  input: { readonly email: string; readonly salt: Uint8Array },
  world: PasskeyWorld = browserWorld(),
): Promise<PasskeyOutput | null> {
  if (!world.present) return null;
  const salt = input.salt as Bytes;
  const made = await world.create({
    publicKey: {
      rp: { id: world.hostname, name: "VEMI" },
      user: { id: randomBytes(16), name: input.email, displayName: "VEMI" },
      challenge: randomBytes(32),
      pubKeyCredParams: [{ type: "public-key", alg: -7 }, { type: "public-key", alg: -257 }],
      authenticatorSelection: { residentKey: "required", userVerification: "required" },
      hints: ["client-device"],
      timeout: 120_000,
      extensions: { prf: { eval: { first: salt } } },
    },
  });
  if (made === null) return null;
  const direct = outputOf(made);
  if (direct !== null) return direct;
  if (made.getClientExtensionResults().prf?.enabled === false) return null;
  const credentialId = toBase64Url(new Uint8Array(made.rawId));
  return passkeyOutput([{ credentialId, salt: toBase64Url(salt) }], world);
}

/** Asks for any of these passkeys. Null when none answers with a PRF output. */
export async function passkeyOutput(
  rows: readonly PasskeyRowRef[],
  world: PasskeyWorld = browserWorld(),
): Promise<PasskeyOutput | null> {
  if (!world.present || rows.length === 0) return null;
  const allow: { type: "public-key"; id: Bytes }[] = [];
  const evalByCredential: Record<string, { first: Bytes }> = {};
  for (const row of rows) {
    const id = fromBase64Url(row.credentialId);
    const salt = fromBase64Url(row.salt);
    if (id === null || salt === null) continue;
    allow.push({ type: "public-key", id });
    evalByCredential[row.credentialId] = { first: salt };
  }
  if (allow.length === 0) return null;
  const got = await world.get({
    publicKey: {
      rpId: world.hostname,
      challenge: randomBytes(32),
      allowCredentials: allow,
      userVerification: "required",
      timeout: 120_000,
      extensions: { prf: { evalByCredential } },
    },
  });
  return outputOf(got);
}
