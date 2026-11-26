import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Decision 3 of the spec: the command centre makes zero model calls at runtime.
 * That is enforced here rather than promised in a comment. If a model API machine or
 * SDK ever reaches the source or a built bundle, this fails the build.
 */

const ROOT = fileURLToPath(new URL("..", import.meta.url));

const FORBIDDEN_HOSTS = [
  "api.anthropic.com",
  "api.openai.com",
  "generativelanguage.googleapis.com",
  "api.mistral.ai",
  "openrouter.ai",
];

const FORBIDDEN_PACKAGES = [
  "@anthropic-ai/sdk",
  "openai",
  "@google/generative-ai",
  "langchain",
];

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "coverage", "tests"]);
const SCAN_EXT = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json", ".html", ".css"];

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (SCAN_EXT.some((e) => entry.endsWith(e))) out.push(full);
  }
  return out;
}

/**
 * Every built output. The Worker bundle is what Cloudflare runs, and a model client
 * reaching it through a dependency is exactly as much of a violation as one in source.
 */
const BUNDLE_DIRS = ["dist/worker", "dist/web", "src/shared/dist", "src/icons/dist"];

/**
 * Every file is scanned. The brand marks used to ship as one chunk carrying each brand's web
 * address, and had to be let off; they are now files holding a path and a title, and the
 * picker's list carries slugs and titles only, so nothing is.
 */
function bundles(): string[] {
  const out: string[] = [];
  for (const dir of BUNDLE_DIRS) {
    try {
      walk(join(ROOT, dir), out);
    } catch {
      // Not built in this run. `pnpm verify` builds first, so under verify every one
      // of these exists; a bare `pnpm test` scans whatever is there.
    }
  }
  return out;
}

describe("no model client", () => {
  const files = [...walk(ROOT), ...bundles()].filter((f) => !f.endsWith("no-model-client.test.ts"));

  it("finds source files to scan", () => {
    expect(files.length).toBeGreaterThan(10);
  });

  it("contains no model API machine anywhere in source or bundle", () => {
    const hits: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      for (const machine of FORBIDDEN_HOSTS) {
        if (text.includes(machine)) hits.push(`${file.replace(ROOT, "")} -> ${machine}`);
      }
    }
    expect(hits).toEqual([]);
  });

  it("declares no model SDK as a dependency", () => {
    const manifests = files.filter((f) => f.endsWith("package.json"));
    const hits: string[] = [];
    for (const file of manifests) {
      const pkg = JSON.parse(readFileSync(file, "utf8")) as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
      const names = [
        ...Object.keys(pkg.dependencies ?? {}),
        ...Object.keys(pkg.devDependencies ?? {}),
      ];
      for (const bad of FORBIDDEN_PACKAGES) {
        if (names.includes(bad)) hits.push(`${file.replace(ROOT, "")} -> ${bad}`);
      }
    }
    expect(hits).toEqual([]);
  });
});
