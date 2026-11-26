/**
 * Icons. Two sets, never mixed, told apart by a prefix.
 *
 * - `lucide:<name>` — Lucide (ISC), for chrome and generic content. Stroked outlines.
 * - `brand:<slug>` — Simple Icons (CC0-1.0), for brand marks and nothing else. Solid fills.
 *
 * The prefix is what makes a collision impossible: `lucide:apple` is a fruit and
 * `brand:apple` is a company, and each resolves only in its own set.
 *
 * Nothing is validated when a name is stored. A name that draws nothing — no prefix, an
 * unknown prefix, a name neither set has, or no name at all — renders as nothing: no
 * placeholder, no throw. A task with no icon shows no icon.
 *
 * Neither set is in the page's code. The build writes every icon as its own file under
 * `/icons/<set>/<name>.svg` (see `assets.ts`), and an icon is fetched the first time it is
 * drawn and remembered. A phone showing six icons downloads six small files, not a loader
 * naming two thousand and a chunk holding three thousand marks. The picker's lists are one
 * more file, fetched when the picker opens.
 *
 * Marks are drawn in `currentColor`: colour carries state in this interface, never a brand's
 * hex.
 *
 * Trademark is not copyright. CC0 covers the Simple Icons project, not each mark, which
 * stays its owner's. Labelling a link to a brand with its mark is nominative use; using a
 * mark as this product's own identity is not.
 */
import { createElement, useEffect, useState, type ReactElement } from "react";

export type IconSet = "lucide" | "brand";

export interface IconRef {
  readonly set: IconSet;
  readonly key: string;
}

/** What one icon draws: the inside of its SVG, ready to go inside an `<svg>` of ours. */
export interface Drawing extends IconRef {
  readonly markup: string;
}

export interface Catalogue {
  readonly lucide: readonly string[];
  readonly brands: readonly { readonly slug: string; readonly title: string }[];
}

/** Where the build puts the icon files. */
export const ICON_ROOT = "/icons";
export const CATALOGUE_PATH = `${ICON_ROOT}/names.json`;

/** Both sets name their files in lower case, digits, hyphens and underscores. */
const KEY = /^[a-z0-9][a-z0-9_-]*$/;

/** A stored name, read. `null` for anything that cannot name an icon in either set. */
export function parseIcon(name: string | null | undefined): IconRef | null {
  if (typeof name !== "string") return null;
  const colon = name.indexOf(":");
  if (colon <= 0) return null;
  const set = name.slice(0, colon);
  const key = name.slice(colon + 1);
  if ((set !== "lucide" && set !== "brand") || !KEY.test(key)) return null;
  return { set, key };
}

export function iconUrl(ref: IconRef): string {
  return `${ICON_ROOT}/${ref.set}/${ref.key}.svg`;
}

/**
 * The drawing inside an SVG file: its outer element, title and comments taken off. `null` for
 * anything that is not a plain drawing, which includes the app's own page, handed back for a
 * path that has no file.
 */
export function drawingOf(ref: IconRef, svg: string): Drawing | null {
  const open = svg.search(/<svg[\s>]/i);
  if (open < 0) return null;
  const start = svg.indexOf(">", open);
  const end = svg.lastIndexOf("</svg>");
  if (start < 0 || end <= start) return null;
  const markup = svg.slice(start + 1, end)
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<title>[\s\S]*?<\/title>/gi, "")
    .replace(/>\s+</g, "><")
    .trim();
  // Only shapes: these files are the build's own, and this keeps them that way.
  if (markup === "" || /<script|<foreignobject|\son[a-z]+\s*=|javascript:/i.test(markup)) return null;
  return { ...ref, markup };
}

/** Settled answers by address: a drawing, or `null` for an icon known not to exist. */
const drawings = new Map<string, Drawing | null>();
const pending = new Map<string, Promise<Drawing | null>>();

/** What is already loaded for a name: a drawing, `null` when there is none, `undefined` when not yet asked. */
export function loadedIcon(name: string | null | undefined): Drawing | null | undefined {
  const ref = parseIcon(name);
  return ref === null ? null : drawings.get(iconUrl(ref));
}

/**
 * Fetch an icon once. A missing icon is remembered as missing; a failure to reach the Worker
 * is not, so the icon is tried again next time it is drawn.
 */
export function loadIcon(name: string | null | undefined, doFetch: typeof fetch = fetch): Promise<Drawing | null> {
  const ref = parseIcon(name);
  if (ref === null) return Promise.resolve(null);
  const url = iconUrl(ref);
  const settled = drawings.get(url);
  if (settled !== undefined) return Promise.resolve(settled);
  const running = pending.get(url);
  if (running !== undefined) return running;
  const work = doFetch(url)
    .then(async (response) => {
      if (!response.ok) {
        if (response.status === 404) drawings.set(url, null);
        return null;
      }
      const type = response.headers.get("content-type") ?? "";
      const drawing = type.includes("svg") ? drawingOf(ref, await response.text()) : null;
      drawings.set(url, drawing);
      return drawing;
    })
    .catch(() => null)
    .finally(() => pending.delete(url));
  pending.set(url, work);
  return work;
}

let catalogue: Promise<Catalogue> | null = null;

/** Every Lucide name and every brand mark's slug and title, for the picker. Fetched once. */
export function loadCatalogue(doFetch: typeof fetch = fetch): Promise<Catalogue> {
  catalogue ??= doFetch(CATALOGUE_PATH)
    .then(async (response) => {
      if (!response.ok) throw new Error(`the icon list answered ${response.status}`);
      return await response.json() as Catalogue;
    })
    .catch((err: unknown) => {
      // Not remembered: a picker opened with no signal should work when it is opened again.
      catalogue = null;
      throw err;
    });
  return catalogue;
}

/** Forget everything loaded. For tests. */
export function forgetIcons(): void {
  drawings.clear();
  pending.clear();
  catalogue = null;
}

export interface IconProps {
  readonly name: string | null | undefined;
  readonly size?: number;
  readonly className?: string;
  /** Read aloud when given. Without one the icon is decoration and hidden from assistive tech. */
  readonly title?: string;
}

export function Icon({ name, size = 24, className, title }: IconProps): ReactElement | null {
  const known = loadedIcon(name);
  const [, arrived] = useState(0);
  useEffect(() => {
    if (known !== undefined) return;
    let mounted = true;
    void loadIcon(name).then(() => {
      if (mounted) arrived((n) => n + 1);
    });
    return () => {
      mounted = false;
    };
  }, [name, known]);

  if (known === undefined || known === null) return null;
  const labelled = title !== undefined && title !== "";
  const shared = {
    xmlns: "http://www.w3.org/2000/svg",
    viewBox: "0 0 24 24",
    width: size,
    height: size,
    role: labelled ? "img" : undefined,
    "aria-hidden": labelled ? undefined : true,
    "aria-label": labelled ? title : undefined,
    dangerouslySetInnerHTML: { __html: known.markup },
  };
  if (known.set === "lucide") {
    return createElement("svg", {
      ...shared,
      className: `lucide lucide-${known.key}${className === undefined ? "" : ` ${className}`}`,
      fill: "none",
      stroke: "currentColor",
      strokeWidth: 2,
      strokeLinecap: "round",
      strokeLinejoin: "round",
    });
  }
  return createElement("svg", { ...shared, className, fill: "currentColor", "data-icon-set": "brand" });
}
