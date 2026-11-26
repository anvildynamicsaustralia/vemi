/**
 * The repository's own side of the release bundle: the script is wired in, the output stays out of
 * git, the notes carry the current version, and the real migrations rise. The bundle itself is
 * tested in scripts/build-release.test.ts against a fixture tree.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { migrationOrderProblems, notesFor } from "../src/shared/setup/releaseManifest.js";
import { ROOT } from "./walk.js";

const read = (path: string): string => readFileSync(join(ROOT, path), "utf8");
const pkg = JSON.parse(read("package.json")) as { version: string; scripts: Record<string, string> };

describe("the release bundle in the repository", () => {
  it("has a release script that builds, then bundles", () => {
    expect(pkg.scripts.release).toBe("pnpm run build && node scripts/build-release.mjs");
  });

  it("keeps dist/release out of git", () => {
    expect(read(".gitignore").split(/\r?\n/)).toContain("dist/release/");
  });

  it("has a section in RELEASE_NOTES.md for the version in package.json", () => {
    expect(notesFor(read("RELEASE_NOTES.md"), pkg.version)).not.toBeNull();
  });

  it("has migrations that rise", () => {
    const names = readdirSync(join(ROOT, "migrations")).filter((n) => n.endsWith(".sql")).sort();
    expect(migrationOrderProblems(names)).toEqual([]);
  });
});
