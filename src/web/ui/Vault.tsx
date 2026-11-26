import { type ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import { keysNow } from "../api.js";
import { refetchShown } from "../state/resources.js";
import { keyChanged, setKeySource } from "../sealedApi.js";
import { type OpenWay, type Opened, keyWays } from "../keyWays.js";
import { prfPossible } from "../passkeyPrf.js";
import { AppLock } from "./AppLock.js";
import { type Vault, type VaultState, createVault } from "../vault.js";
import { VaultContext, type VaultView } from "./vaultContext.js";

/** The key moved to `state`: answers open again, and a key that just opened brings the shown screens up where they stand. */
export function keyMoved(state: VaultState, refetch: () => void): void {
  keyChanged();
  if (state === "open") refetch();
}

/**
 * Gives `useVault()` the state of this device's key for `account`: `unknown` until looked at,
 * then `none` (no key yet), `closed` (a key exists, this device does not hold it) or `open`.
 * A different account, or none, starts again from `unknown` and drops the key from memory.
 * `vault` is for tests, which hand in one built on fakes.
 */
export function VaultProvider({ account, vault: given, children }: {
  readonly account: string | null;
  readonly vault?: Vault;
  readonly children: ReactNode;
}) {
  const vault = useMemo(
    () => given ?? (account === null ? null : createVault(account, { keysNow })),
    [account, given],
  );
  const [state, setState] = useState<VaultState>("unknown");

  const refresh = useCallback(async (): Promise<void> => {
    if (vault === null) return;
    await vault.reload();
    setState(await vault.state());
  }, [vault]);

  // Signing out, or another account coming in, leaves nothing open.
  useEffect(() => {
    setState("unknown");
    if (vault === null) return;
    let mounted = true;
    void (async () => {
      const next = await vault.state();
      if (mounted) setState(next);
    })();
    return () => {
      mounted = false;
    };
  }, [vault]);

  // The app's sealing layer reads the key through this vault, and redraws its answers when the key changes.
  useEffect(() => {
    if (vault === null) return undefined;
    setKeySource(async () => {
      const held = await vault.held();
      return held === null ? null : { fieldKey: held.fieldKey, keyRef: held.keyRef };
    });
    return () => setKeySource(null);
  }, [vault]);
  // A key that opens on a screen already drawn locked brings it up where it stands, not at the next visit.
  useEffect(() => {
    keyMoved(state, refetchShown);
  }, [state]);

  const view = useMemo<VaultView>(() => ({
    account,
    state,
    sealField: async (kind, id, field, text) => (vault === null ? null : vault.sealField(kind, id, field, text)),
    openField: async (kind, id, field, stored) => {
      if (vault === null) return { status: "locked" };
      return vault.openField(kind, id, field, stored);
    },
    opened(result: Opened) {
      if (vault === null) return;
      vault.hold({ fieldKey: result.fieldKey, keyRef: result.keyRef, deviceId: result.deviceId ?? "" });
      setState("open");
    },
    refresh,
  }), [account, state, vault, refresh]);

  const ways = useMemo(() => (account === null ? null : keyWays(account)), [account]);
  const prf = useMemo(() => prfPossible(), []);
  const prove = useCallback(async (way: OpenWay): Promise<void> => {
    if (ways === null) return;
    await ways.prove(way);
  }, [ways]);

  return (
    <VaultContext.Provider value={view}>
      <AppLock key={account ?? ""} account={account} prf={prf} loadKeys={keysNow} prove={prove}>{children}</AppLock>
    </VaultContext.Provider>
  );
}
