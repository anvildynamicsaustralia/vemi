import { createContext, useContext } from "react";
import { type LockableField, type LockableKind, isSealed } from "@vemi/shared";
import type { Opened } from "../keyWays.js";
import type { FieldAnswer, VaultState } from "../vault.js";

/**
 * What a screen can ask of the vault on this device. `state` redraws the screen when the key is
 * opened here and when the person signs out. No method here sends anything.
 */
export interface VaultView {
  /** The account this vault is for, or null when nobody is signed in. */
  readonly account: string | null;
  readonly state: VaultState;
  sealField<K extends LockableKind>(kind: K, id: string, field: LockableField<K>, text: string): Promise<string | null>;
  openField<K extends LockableKind>(kind: K, id: string, field: LockableField<K>, stored: string): Promise<FieldAnswer>;
  /** Tell the vault a way in just worked (after `KeySetup` or `KeyUnlock`), so every screen redraws open. */
  opened(result: Opened): void;
  /** Look again, after a restore or when the key may have been forgotten. */
  refresh(): Promise<void>;
}

/** Outside a provider nothing is known and nothing opens. */
const CLOSED: VaultView = {
  account: null,
  state: "unknown",
  sealField: async () => null,
  openField: async (_kind, _id, _field, stored) => (isSealed(stored) ? { status: "locked" } : { status: "open", text: stored }),
  opened: () => undefined,
  refresh: async () => undefined,
};

export const VaultContext = createContext<VaultView>(CLOSED);

export function useVault(): VaultView {
  return useContext(VaultContext);
}
