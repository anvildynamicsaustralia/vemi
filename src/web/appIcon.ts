import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The app icon is artwork, not code: `brand/icons/` holds the files, written by
 * `scripts/make-brand.mjs` from the traced wordmark in `brand/vemi-wordmark.svg`. This module
 * names them and hands them to the build (`vite.config.ts`) and the dev server.
 */
export type MarkName = "regular" | "maskable";

export interface IconFile {
  readonly fileName: string;
  readonly mark: MarkName;
  /** The pixel size of a PNG; the SVGs scale and carry 0. */
  readonly size: number;
}

/** Every file the build emits for the app icon, so nothing else keeps a second list. */
export const ICON_FILES: readonly IconFile[] = [
  { fileName: "icon.svg", mark: "regular", size: 0 },
  { fileName: "icon-maskable.svg", mark: "maskable", size: 0 },
  { fileName: "icon-192.png", mark: "regular", size: 192 },
  { fileName: "icon-512.png", mark: "regular", size: 512 },
  { fileName: "icon-maskable-512.png", mark: "maskable", size: 512 },
  { fileName: "apple-touch-icon.png", mark: "regular", size: 180 },
];

/** The folder the files sit in, found from the repo root (the build and the tests both run there). */
export const ICON_DIR = join(process.cwd(), "brand", "icons");

/** The bytes of one icon file. */
export function iconBytes(fileName: string): Uint8Array {
  return readFileSync(join(ICON_DIR, fileName));
}
