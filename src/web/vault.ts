/**
 * The vault on this device: seals and opens one locked field with the field key this device
 * holds (see deviceKey.ts). The key never leaves this module as bytes, and nothing here sends
 * anything: callers get an envelope or text back and do their own saving. A field that cannot
 * be read is answered as `locked` or `damaged`, never thrown.
 */
import {
  CryptoError,
  type LockableField,
  type LockableKind,
  envelopeKeyRef,
  isSealed,
  lockBinding,
  open,
  seal,
} from "@vemi/shared";
import type { KeyState } from "./api.js";
import { type DeviceKey, type KeyShelf, browserShelf, deviceKey } from "./deviceKey.js";

/** What this device can say about the account's key. `unknown` is until it has looked, or when it cannot tell. */
export type VaultState = "unknown" | "none" | "closed" | "open";

export type FieldAnswer =
  | { readonly status: "open"; readonly text: string }
  | { readonly status: "locked" }
  | { readonly status: "damaged" };

export interface VaultDeps {
  /** Where the key is kept; the browser's by default. */
  readonly shelf?: KeyShelf;
  /** The Worker's key rows; used only to tell `none` from `closed`. */
  readonly keysNow: () => Promise<KeyState>;
}

export interface Vault {
  /** The key this device holds, read once and then kept in memory until `reload`. */
  held(): Promise<DeviceKey | null>;
  /** Reads the shelf again. */
  reload(): Promise<DeviceKey | null>;
  /** Holds a key in memory for this session, for a browser that cannot keep it on the shelf. */
  hold(key: DeviceKey | null): void;
  state(): Promise<VaultState>;
  /** The envelope for `text`, or null when this device holds no key. */
  sealField<K extends LockableKind>(kind: K, id: string, field: LockableField<K>, text: string): Promise<string | null>;
  /** Plain text answers `open` as it is; an envelope answers by what the held key can do. Never throws. */
  openField<K extends LockableKind>(kind: K, id: string, field: LockableField<K>, stored: string): Promise<FieldAnswer>;
}

export function createVault(account: string, deps: VaultDeps): Vault {
  const shelf = deps.shelf ?? browserShelf();
  let current: DeviceKey | null | undefined;

  const reload = async (): Promise<DeviceKey | null> => {
    current = await deviceKey(account, shelf);
    return current;
  };
  const held = async (): Promise<DeviceKey | null> => (current === undefined ? reload() : current);

  return {
    held,
    reload,
    hold(key) {
      current = key;
    },
    async state() {
      if ((await held()) !== null) return "open";
      try {
        return (await deps.keysNow()).keyRef === null ? "none" : "closed";
      } catch {
        return "unknown";
      }
    },
    async sealField(kind, id, field, text) {
      const key = await held();
      if (key === null) return null;
      return seal(key.fieldKey, key.keyRef, text, lockBinding(kind, id, field));
    },
    async openField(kind, id, field, stored) {
      if (!isSealed(stored)) return { status: "open", text: stored };
      try {
        const key = await held();
        if (key === null || envelopeKeyRef(stored) !== key.keyRef) return { status: "locked" };
        const text = await open(key.fieldKey, stored, { ...lockBinding(kind, id, field), keyRef: key.keyRef });
        return { status: "open", text };
      } catch (error) {
        return error instanceof CryptoError && error.reason === "key" ? { status: "locked" } : { status: "damaged" };
      }
    },
  };
}
