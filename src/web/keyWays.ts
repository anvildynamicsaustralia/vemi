/**
 * Setting up, opening and adding ways in to the account key, on this device.
 *
 * The account key is made here and leaves only wrapped: once per way in (a passkey's PRF
 * output, the vault password, the recovery key) or sealed to one new device's public half.
 * The Worker holds wrapped copies and never an unwrapped key or a password. This device keeps
 * only the field key (see deviceKey.ts). Every call here is a plain request, never queued.
 */
import {
  type Bytes,
  CryptoError,
  PASSWORD_MIN,
  VAULT_ITERATIONS,
  fromBase64Url,
  formatRecoveryKey,
  keysFrom,
  makeAccountKey,
  makeRecoveryKey,
  makeVaultSalt,
  openFromPairing,
  pairingKeys,
  pairingPublic,
  parseRecoveryKey,
  passkeyWrappingKey,
  passwordWrappingKey,
  randomBytes,
  recoveryWrappingKey,
  sameKey,
  sealForPairing,
  toBase64Url,
  unwrapKey,
  wrapKey,
} from "@vemi/shared";
import { type KeyApi, type KeyRow, type KeyRowInput, type KeyState, keyApi } from "./api.js";
import { type DeviceKey, type KeyShelf, browserShelf, deviceKey, forgetDeviceKey, keepDeviceKey } from "./deviceKey.js";
import { type PasskeyOutput, type PasskeyRowRef, makePasskey, passkeyOutput, prfPossible } from "./passkeyPrf.js";

export type SetUpWay = { readonly kind: "passkey" } | { readonly kind: "password"; readonly password: string };
export type OpenWay = SetUpWay | { readonly kind: "recovery"; readonly recoveryKey: string };

export type KeyWayProblem = "none" | "wrong" | "nopasskey" | "weak" | "device";

/** A way in that did not work. The message is a plain sentence, ready to show. */
export class KeyWayError extends Error {
  constructor(readonly problem: KeyWayProblem, message: string) {
    super(message);
    this.name = "KeyWayError";
  }
}

const WRONG = "That didn't work. Try again.";

export interface Passkeys {
  possible(): boolean;
  make(input: { readonly email: string; readonly salt: Uint8Array }): Promise<PasskeyOutput | null>;
  output(rows: readonly PasskeyRowRef[]): Promise<PasskeyOutput | null>;
}

export interface KeyDeps {
  readonly api: KeyApi;
  readonly shelf: KeyShelf;
  readonly passkeys: Passkeys;
  /** Names this device in the list of devices. */
  readonly label: string;
  readonly makeKey: () => Bytes;
  readonly newId: () => string;
}

/** The browser and system, in words: "Chrome on Windows". At most 60 characters. */
export function deviceLabel(ua: string): string {
  const browser = /Edg(e|A|iOS)?\//.test(ua) ? "Edge"
    : /OPR\/|Opera/.test(ua) ? "Opera"
    : /Firefox\/|FxiOS/.test(ua) ? "Firefox"
    : /Chrome\/|CriOS/.test(ua) ? "Chrome"
    : /Safari\//.test(ua) ? "Safari"
    : "Browser";
  const system = /iPhone/.test(ua) ? "iPhone"
    : /iPad/.test(ua) ? "iPad"
    : /Android/.test(ua) ? "Android"
    : /Windows/.test(ua) ? "Windows"
    : /Mac OS X|Macintosh/.test(ua) ? "Mac"
    : /CrOS/.test(ua) ? "ChromeOS"
    : /Linux/.test(ua) ? "Linux"
    : "";
  return (system === "" ? browser : `${browser} on ${system}`).slice(0, 60);
}

export function browserDeps(): KeyDeps {
  return {
    api: keyApi,
    shelf: browserShelf(),
    passkeys: { possible: () => prfPossible(), make: (input) => makePasskey(input), output: (rows) => passkeyOutput(rows) },
    label: deviceLabel(typeof navigator === "undefined" ? "" : navigator.userAgent),
    makeKey: makeAccountKey,
    newId: () => crypto.randomUUID(),
  };
}

/** What a device holds after a way in worked. `kept` is false where the browser cannot keep it. */
export interface Opened {
  readonly fieldKey: CryptoKey;
  readonly keyRef: string;
  readonly deviceId: string | null;
  readonly kept: boolean;
}

/** A key made on this device and not yet sent. Nothing reaches the Worker until `save()`. */
export interface PendingKey {
  /** Shown once. */
  readonly recoveryKey: string;
  save(): Promise<Opened>;
}

export interface PendingRecovery {
  readonly recoveryKey: string;
  save(): Promise<void>;
}

export interface PairingHandle {
  readonly id: string;
  /** What the link carries after the pairing id. Never sent to the Worker. */
  readonly publicPart: string;
  readonly keys: CryptoKeyPair;
}

export type DeviceCheck = "none" | "kept" | "forgotten";

const live = (state: KeyState, kind: KeyRow["kind"]): KeyRow[] => state.wraps.filter((w) => w.kind === kind);

function deviceRow(id: string, label: string): KeyRowInput {
  return { id, kind: "device", label, deviceId: null, credentialId: null, salt: null, iterations: null, wrapped: null };
}

export function keyWays(account: string, deps: KeyDeps = browserDeps()) {
  const { api, shelf } = deps;

  /** The account key, from one way in and the rows the Worker holds. */
  async function accountKeyFrom(way: OpenWay, state: KeyState): Promise<Bytes> {
    const { keyRef, keyCheck } = state;
    if (keyRef === null || keyCheck === null) throw new KeyWayError("none", "There is no key yet.");
    let found: Bytes | null = null;
    try {
      if (way.kind === "passkey") {
        const rows = live(state, "passkey").filter((r) => r.credentialId !== null && r.salt !== null && r.wrapped !== null);
        if (rows.length === 0) throw new KeyWayError("nopasskey", "No Face ID or fingerprint is set up for this key.");
        const got = await deps.passkeys.output(rows.map((r) => ({ credentialId: r.credentialId ?? "", salt: r.salt ?? "" })));
        const row = got === null ? undefined : rows.find((r) => r.credentialId === got.credentialId);
        if (got !== null && row?.wrapped) found = await unwrapKey(await passkeyWrappingKey(got.output), row.wrapped, "passkey", keyRef);
      } else if (way.kind === "password") {
        for (const row of live(state, "password")) {
          const salt = fromBase64Url(row.salt ?? "");
          if (salt === null || row.wrapped === null || row.iterations === null) continue;
          try {
            found = await unwrapKey(await passwordWrappingKey(way.password, salt, row.iterations), row.wrapped, "password", keyRef);
            break;
          } catch (error) {
            if (!(error instanceof CryptoError)) throw error;
          }
        }
      } else {
        const bytes = await parseRecoveryKey(way.recoveryKey);
        const row = live(state, "recovery")[0];
        if (row?.wrapped) found = await unwrapKey(await recoveryWrappingKey(bytes), row.wrapped, "recovery", keyRef);
      }
    } catch (error) {
      if (error instanceof KeyWayError) throw error;
      throw new KeyWayError("wrong", WRONG);
    }
    if (found === null || !(await sameKey(found, keyCheck))) throw new KeyWayError("wrong", WRONG);
    return found;
  }

  /** Adds this device's row and keeps the field key. A device that cannot keep it leaves no row. */
  async function enroll(accountKey: Bytes, state: KeyState): Promise<Opened> {
    const keys = await keysFrom(accountKey);
    const deviceId = deps.newId();
    await api.addKeys({ keyRef: keys.keyRef, keyCheck: state.keyCheck ?? keys.keyCheck, wraps: [deviceRow(deviceId, deps.label)] });
    const kept = await keepDeviceKey(account, { fieldKey: keys.fieldKey, keyRef: keys.keyRef, deviceId }, shelf);
    if (!kept) {
      await api.archiveKey(deviceId).catch(() => undefined);
      return { fieldKey: keys.fieldKey, keyRef: keys.keyRef, deviceId: null, kept: false };
    }
    return { fieldKey: keys.fieldKey, keyRef: keys.keyRef, deviceId, kept: true };
  }

  async function wrapRow(
    accountKey: Bytes,
    keyRef: string,
    way: SetUpWay,
    deviceId: string | null,
  ): Promise<KeyRowInput> {
    if (way.kind === "password") {
      if (way.password.length < PASSWORD_MIN) throw new KeyWayError("weak", `Use at least ${PASSWORD_MIN} characters.`);
      const salt = makeVaultSalt();
      const wrapped = await wrapKey(await passwordWrappingKey(way.password, salt, VAULT_ITERATIONS), accountKey, "password", keyRef);
      return {
        id: deps.newId(), kind: "password", label: "Vault password", deviceId: null, credentialId: null,
        salt: toBase64Url(salt), iterations: VAULT_ITERATIONS, wrapped,
      };
    }
    if (deviceId === null) throw new KeyWayError("device", "This device is not set up for it.");
    const salt = randomBytes(32);
    const made = await deps.passkeys.make({ email: account, salt });
    if (made === null) throw new KeyWayError("nopasskey", "This device has no Face ID or fingerprint to use.");
    const wrapped = await wrapKey(await passkeyWrappingKey(made.output), accountKey, "passkey", keyRef);
    return {
      id: deps.newId(), kind: "passkey", label: deps.label, deviceId, credentialId: made.credentialId,
      salt: toBase64Url(salt), iterations: null, wrapped,
    };
  }

  async function recoveryRow(accountKey: Bytes, keyRef: string): Promise<{ row: KeyRowInput; text: string }> {
    const bytes = makeRecoveryKey();
    const wrapped = await wrapKey(await recoveryWrappingKey(bytes), accountKey, "recovery", keyRef);
    return {
      row: { id: deps.newId(), kind: "recovery", label: "Recovery key", deviceId: null, credentialId: null, salt: null, iterations: null, wrapped },
      text: await formatRecoveryKey(bytes),
    };
  }

  /** Makes a whole new key with `way` and a recovery key. Nothing is sent until `save()`. */
  async function prepare(way: SetUpWay, replacing: boolean): Promise<PendingKey> {
    const accountKey = deps.makeKey();
    const keys = await keysFrom(accountKey);
    const deviceId = deps.newId();
    const wayRow = await wrapRow(accountKey, keys.keyRef, way, deviceId);
    const recovery = await recoveryRow(accountKey, keys.keyRef);
    const bundle = { keyRef: keys.keyRef, keyCheck: keys.keyCheck, wraps: [deviceRow(deviceId, deps.label), recovery.row, wayRow] };
    return {
      recoveryKey: recovery.text,
      async save() {
        await (replacing ? api.startAgain(bundle) : api.addKeys(bundle));
        const kept = await keepDeviceKey(account, { fieldKey: keys.fieldKey, keyRef: keys.keyRef, deviceId }, shelf);
        return { fieldKey: keys.fieldKey, keyRef: keys.keyRef, deviceId: kept ? deviceId : null, kept };
      },
    };
  }

  return {
    /** Makes the key and its first wrappings; the recovery key is shown before `save()` sends anything. */
    prepareSetUp: (way: SetUpWay) => prepare(way, false),
    /** The same with a new key over an old one, every old row archived. */
    prepareStartAgain: (way: SetUpWay) => prepare(way, true),

    async setUp(way: SetUpWay): Promise<{ readonly recoveryKey: string; readonly opened: Opened }> {
      const pending = await prepare(way, false);
      return { recoveryKey: pending.recoveryKey, opened: await pending.save() };
    },

    /** Opens the key with one way in and keeps it on this device. */
    async openWith(way: OpenWay): Promise<Opened> {
      const state = await api.keysNow();
      return enroll(await accountKeyFrom(way, state), state);
    },

    /** Checks one way in against the Worker's rows. Adds no device row and keeps nothing. */
    async prove(way: OpenWay): Promise<void> {
      await accountKeyFrom(way, await api.keysNow());
    },

    /**
     * A fresh device row for a key this device already holds, used after a restore: the restore
     * gave every row a new id, so this device's own row is gone. Refuses a key that is not the
     * one the Worker now holds.
     */
    async rejoin(key: Pick<DeviceKey, "fieldKey" | "keyRef">): Promise<Opened> {
      const state = await api.keysNow();
      if (state.keyRef === null || state.keyCheck === null) throw new KeyWayError("none", "There is no key yet.");
      if (state.keyRef !== key.keyRef) throw new KeyWayError("wrong", WRONG);
      const deviceId = deps.newId();
      await api.addKeys({ keyRef: state.keyRef, keyCheck: state.keyCheck, wraps: [deviceRow(deviceId, deps.label)] });
      const kept = await keepDeviceKey(account, { fieldKey: key.fieldKey, keyRef: key.keyRef, deviceId }, shelf);
      if (!kept) {
        await api.archiveKey(deviceId).catch(() => undefined);
        return { fieldKey: key.fieldKey, keyRef: key.keyRef, deviceId: null, kept: false };
      }
      return { fieldKey: key.fieldKey, keyRef: key.keyRef, deviceId, kept: true };
    },

    /** Adds a way in. Asks `proof`, one way in, because a new wrapping needs the whole key. */
    async addWay(way: SetUpWay, proof: OpenWay): Promise<void> {
      const state = await api.keysNow();
      const accountKey = await accountKeyFrom(proof, state);
      const { keyRef, keyCheck } = state;
      if (keyRef === null || keyCheck === null) throw new KeyWayError("none", "There is no key yet.");
      const here = await deviceKey(account, shelf);
      const row = await wrapRow(accountKey, keyRef, way, here?.deviceId ?? null);
      await api.addKeys({ keyRef, keyCheck, wraps: [row] });
      // A changed vault password replaces the old one.
      if (way.kind === "password") for (const old of live(state, "password")) await api.archiveKey(old.id);
    },

    removeWay: (id: string) => api.archiveKey(id),

    /** A new recovery key, shown before `save()` archives the old one and adds it. */
    async newRecoveryKey(proof: OpenWay): Promise<PendingRecovery> {
      const state = await api.keysNow();
      const accountKey = await accountKeyFrom(proof, state);
      if (state.keyRef === null) throw new KeyWayError("none", "There is no key yet.");
      const recovery = await recoveryRow(accountKey, state.keyRef);
      return { recoveryKey: recovery.text, save: async () => { await api.replaceRecovery(recovery.row); } };
    },

    /** The new device: opens a pairing and returns what the link carries. */
    async startPairing(): Promise<PairingHandle> {
      const keys = await pairingKeys();
      const id = toBase64Url(randomBytes(16));
      await api.openPairing(id);
      return { id, publicPart: await pairingPublic(keys), keys };
    },

    /** The new device: null while waiting, else the key is checked, kept and this device listed. */
    async finishPairing(handle: PairingHandle): Promise<Opened | null> {
      // The key's rows first: reading the pairing consumes the sealed copy, so a failure after it would lose it.
      const state = await api.keysNow();
      const answer = await api.readPairing(handle.id);
      if ("waiting" in answer) return null;
      let accountKey: Bytes;
      try {
        accountKey = await openFromPairing(handle.keys, answer.sealed, handle.id);
      } catch {
        throw new KeyWayError("wrong", WRONG);
      }
      if (state.keyCheck === null || !(await sameKey(accountKey, state.keyCheck))) throw new KeyWayError("wrong", WRONG);
      return enroll(accountKey, state);
    },

    /** The unlocked device: seals the key to the new device's public half and leaves it for them. */
    async allowPairing(proof: OpenWay, pairingId: string, theirPublic: string): Promise<void> {
      const state = await api.keysNow();
      const accountKey = await accountKeyFrom(proof, state);
      const sealed = await sealForPairing(accountKey, theirPublic, pairingId);
      await api.fillPairing(pairingId, { sealed });
    },

    /**
     * After sign-in and on open: a device whose row is gone, or whose key was replaced, forgets
     * its key. An answer that cannot be had changes nothing.
     */
    async checkDevice(): Promise<DeviceCheck> {
      const here = await deviceKey(account, shelf);
      if (here === null) return "none";
      let state: KeyState;
      try {
        state = await api.keysNow();
      } catch {
        return "kept";
      }
      const listed = state.wraps.some((w) => w.kind === "device" && w.id === here.deviceId);
      if (listed && state.keyRef === here.keyRef) return "kept";
      await forgetDeviceKey(account, shelf);
      return "forgotten";
    },

    forget: () => forgetDeviceKey(account, shelf),
    held: (): Promise<DeviceKey | null> => deviceKey(account, shelf),
  };
}

/** Runs the device check for the real browser. Never rejects. */
export async function checkDeviceKey(account: string | null): Promise<void> {
  if (account === null) return;
  try {
    await keyWays(account).checkDevice();
  } catch {
    // Nothing to change when the check cannot run.
  }
}

/** Forgets this account's key on this device. Never rejects. */
export async function forgetKeyHere(account: string | null): Promise<void> {
  if (account === null) return;
  await forgetDeviceKey(account);
}
