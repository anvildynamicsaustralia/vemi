import { readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

/** The repository root. */
export const ROOT = fileURLToPath(new URL("..", import.meta.url).href);

/** Never this codebase's to scan: installed packages, build output, history, reference. */
const SKIP = new Set(["node_modules", ".git", "dist", "coverage", ".wrangler", ".idea", "data", ".works", "vemi-design"]);

/** Every file under `dir` with one of `extensions`, as a path relative to the root with forward slashes. */
export function walk(dir: string, extensions: readonly string[]): string[] {
  const out: string[] = [];
  const visit = (at: string): void => {
    for (const entry of readdirSync(at)) {
      if (SKIP.has(entry)) continue;
      const full = join(at, entry);
      if (statSync(full).isDirectory()) visit(full);
      else if (extensions.some((e) => entry.endsWith(e))) out.push(relative(ROOT, full).split(sep).join("/"));
    }
  };
  visit(join(ROOT, dir));
  return out;
}

/** Root markdown files that are rules and decisions for the builders; the same list scripts/scan-em-dash.mjs leaves out. */
export const INTERNAL_ROOT_DOCS: readonly string[] = ["AGENTS.md", "CLAUDE.md"];

/** Every root markdown file a visitor reads, as a path relative to the root. */
export function publicRootDocs(): string[] {
  return readdirSync(ROOT).filter((name) => name.endsWith(".md") && !INTERNAL_ROOT_DOCS.includes(name) && statSync(join(ROOT, name)).isFile());
}

/** Test code: a `.test.` file, the API's test helpers, or this directory. */
export function isTestCode(file: string): boolean {
  return file.includes(".test.") || file.startsWith("tests/") || file.startsWith("src/api/testing/");
}
