/**
 * Clearing this device (move-to-cloud, Task 7): the browser database, the saved keys and the
 * session, all at once and only when asked. Nothing here runs by itself; the page's "Clear this
 * device" tap is the only caller. The database goes first: if it cannot be let go (another tab
 * still holds it) nothing else is touched, so a failed clear leaves the device as it was.
 */
import { browserShelf, type KeyShelf } from "../deviceKey.js";
import { LOCAL_KEY_NAME } from "./mode.js";
import type { StorageLike } from "./storage.js";

/** The OPFS directory the database worker keeps its file in (`OPFS_DIRECTORY` in `src/local/opfsDirectory.ts`, checked by a test). */
export const DEVICE_DIRECTORY = "vemi-local";

/**
 * Removes this device's own saved key and no other. `/try` shares its origin, and so the key database,
 * with a signed-in copy in the same browser; deleting the whole database would sign that copy's
 * locked notes and app lock off this device too.
 */
export function removeLocalKey(shelf: KeyShelf): Promise<void> {
  return shelf.remove(LOCAL_KEY_NAME);
}

export interface WipeDeps {
  /** Lets go of the database file and stops the worker that holds it. */
  closeDatabase(): Promise<void>;
  /** Removes a directory of the browser's private file system with everything in it. */
  removeDirectory(name: string): Promise<void>;
  /** Removes the saved device keys. */
  deleteKeys(): Promise<void>;
  /** The page's storage as the app sees it: only keys under the local prefix. */
  readonly local: StorageLike;
  readonly session: StorageLike;
}

export type WipeResult = { readonly ok: true; readonly said: string } | { readonly ok: false; readonly reason: string };

export const WIPED = "Cleared this device: the database, the saved keys and this session.";
const HELD = "This device's data is still held by another tab, so nothing was cleared.";
const KEYS_STAY = "The database is cleared but the saved keys could not be removed.";

export async function wipeDevice(deps: WipeDeps): Promise<WipeResult> {
  try {
    await deps.closeDatabase();
    await deps.removeDirectory(DEVICE_DIRECTORY).catch((error: unknown) => {
      // Never made, or already gone: there is nothing left to hold.
      if (error instanceof Error && error.name === "NotFoundError") return;
      throw error;
    });
  } catch {
    return { ok: false, reason: HELD };
  }
  try {
    await deps.deleteKeys();
  } catch {
    return { ok: false, reason: KEYS_STAY };
  }
  try {
    deps.local.clear();
    deps.session.clear();
  } catch {
    // A browser that refuses its storage holds nothing to clear.
  }
  return { ok: true, said: WIPED };
}

/** The real browser: its private file system, its key database and its storage. */
export function browserWipeDeps(closeDatabase: () => Promise<void>): WipeDeps {
  return {
    closeDatabase,
    removeDirectory: async (name) => {
      const root = await navigator.storage.getDirectory();
      await root.removeEntry(name, { recursive: true });
    },
    deleteKeys: () => removeLocalKey(browserShelf()),
    local: window.localStorage,
    session: window.sessionStorage,
  };
}
