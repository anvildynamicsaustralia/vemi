/**
 * The key this device keeps, per account.
 *
 * Only the field key stays here: a non-extractable AES-GCM key, so a script on the page can
 * use it but never read its bytes. It sits in IndexedDB `vemi-keys` with the key ref it
 * belongs to and the id of this device's row on the server. Nothing here throws: a browser
 * that cannot keep the key simply asks for a way in on each open.
 */

export interface DeviceKey {
  readonly fieldKey: CryptoKey;
  readonly keyRef: string;
  readonly deviceId: string;
}

/** Where the entries live. The default is IndexedDB; tests hand in an in-memory one. */
export interface KeyShelf {
  get(account: string): Promise<unknown>;
  put(account: string, value: DeviceKey): Promise<void>;
  remove(account: string): Promise<void>;
}

const DATABASE = "vemi-keys";
const STORE = "keys";

function openDatabase(factory: IDBFactory): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = factory.open(DATABASE, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("The key store did not open."));
    request.onblocked = () => reject(new Error("The key store is blocked."));
  });
}

async function run<T>(
  factory: IDBFactory,
  mode: IDBTransactionMode,
  act: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const db = await openDatabase(factory);
  try {
    return await new Promise<T>((resolve, reject) => {
      const transaction = db.transaction(STORE, mode);
      const request = act(transaction.objectStore(STORE));
      transaction.oncomplete = () => resolve(request.result);
      transaction.onerror = () => reject(transaction.error ?? new Error("The key store failed."));
      transaction.onabort = () => reject(transaction.error ?? new Error("The key store failed."));
    });
  } finally {
    db.close();
  }
}

/** IndexedDB as a shelf. */
export function indexedShelf(factory: IDBFactory): KeyShelf {
  return {
    get: (account) => run(factory, "readonly", (store) => store.get(account)),
    put: async (account, value) => {
      await run(factory, "readwrite", (store) => store.put(value, account));
    },
    remove: async (account) => {
      await run(factory, "readwrite", (store) => store.delete(account));
    },
  };
}

/** The browser's shelf, or one that keeps nothing where IndexedDB is missing. */
export function browserShelf(): KeyShelf {
  const factory = typeof indexedDB === "undefined" ? undefined : indexedDB;
  if (factory === undefined) {
    return { get: async () => undefined, put: () => Promise.reject(new Error("No key store.")), remove: async () => undefined };
  }
  return indexedShelf(factory);
}

function isDeviceKey(value: unknown): value is DeviceKey {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.keyRef === "string" && typeof v.deviceId === "string" && typeof v.fieldKey === "object" && v.fieldKey !== null;
}

/** What this device holds for the account, or null. */
export async function deviceKey(account: string, shelf: KeyShelf = browserShelf()): Promise<DeviceKey | null> {
  try {
    const found = await shelf.get(account);
    return isDeviceKey(found) ? found : null;
  } catch {
    return null;
  }
}

/** True when the key is now kept here. */
export async function keepDeviceKey(account: string, key: DeviceKey, shelf: KeyShelf = browserShelf()): Promise<boolean> {
  try {
    await shelf.put(account, { fieldKey: key.fieldKey, keyRef: key.keyRef, deviceId: key.deviceId });
    return true;
  } catch {
    return false;
  }
}

export async function forgetDeviceKey(account: string, shelf: KeyShelf = browserShelf()): Promise<void> {
  try {
    await shelf.remove(account);
  } catch {
    // A shelf that cannot be reached kept nothing.
  }
}

/** An in-memory shelf, for tests. */
export function memoryShelf(): KeyShelf & { readonly entries: Map<string, DeviceKey> } {
  const entries = new Map<string, DeviceKey>();
  return {
    entries,
    get: async (account) => entries.get(account),
    put: async (account, value) => {
      entries.set(account, value);
    },
    remove: async (account) => {
      entries.delete(account);
    },
  };
}
