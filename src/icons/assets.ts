/**
 * The icon files, for the build and the development server. Node only; the page never
 * imports this.
 *
 * Every Lucide icon and every Simple Icons mark becomes a file at
 * `icons/<set>/<name>.svg`, copied as the package ships it (Lucide's files keep their ISC
 * notice), and `icons/names.json` lists both sets for the picker: names, slugs and titles,
 * and nothing else from the brand data.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Catalogue } from "./index.js";

const MODULES = fileURLToPath(new URL("../../node_modules/", import.meta.url));
const LUCIDE = join(MODULES, "lucide-static", "icons");
const BRANDS = join(MODULES, "simple-icons", "icons");
const BRAND_DATA = join(MODULES, "simple-icons", "data", "simple-icons.json");

export interface IconFile {
  /** Relative to the build's output, `icons/…`. */
  readonly fileName: string;
  readonly source: string;
}

const svgNames = (dir: string): string[] =>
  readdirSync(dir).filter((f) => f.endsWith(".svg")).map((f) => f.slice(0, -4)).sort();

export function catalogue(): Catalogue {
  const data = JSON.parse(readFileSync(BRAND_DATA, "utf8")) as readonly { readonly slug?: unknown; readonly title?: unknown }[];
  const brands = data
    .filter((b): b is { slug: string; title: string } => typeof b.slug === "string" && typeof b.title === "string")
    .filter((b) => existsSync(join(BRANDS, `${b.slug}.svg`)))
    .map((b) => ({ slug: b.slug, title: b.title }));
  return { lucide: svgNames(LUCIDE), brands };
}

export function iconFiles(): IconFile[] {
  const files: IconFile[] = [];
  for (const name of svgNames(LUCIDE)) {
    files.push({ fileName: `icons/lucide/${name}.svg`, source: readFileSync(join(LUCIDE, `${name}.svg`), "utf8") });
  }
  for (const name of svgNames(BRANDS)) {
    files.push({ fileName: `icons/brand/${name}.svg`, source: readFileSync(join(BRANDS, `${name}.svg`), "utf8") });
  }
  files.push({ fileName: "icons/names.json", source: JSON.stringify(catalogue()) });
  return files;
}

const FILE = /^(lucide|brand)\/([a-z0-9][a-z0-9_-]*)\.svg$/;

/** One file by its path under `icons/`, for the development server. `null` when there is none. */
export function iconFile(path: string): string | null {
  if (path === "names.json") return JSON.stringify(catalogue());
  const match = FILE.exec(path);
  if (match === null) return null;
  const file = join(match[1] === "lucide" ? LUCIDE : BRANDS, `${match[2]}.svg`);
  return existsSync(file) ? readFileSync(file, "utf8") : null;
}
