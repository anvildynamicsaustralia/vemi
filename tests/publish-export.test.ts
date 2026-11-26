/**
 * The public export copies only what is public, scans it, makes one commit, and never pushes.
 */
import { afterAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const SCRIPT = resolve(import.meta.dirname, "..", "scripts", "publish-export.sh");
const made: string[] = [];
const dir = (): string => {
  const d = mkdtempSync(join(tmpdir(), "vemi-export-"));
  made.push(d);
  return d;
};
const git = (cwd: string, ...args: string[]) => spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });

afterAll(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
});

describe("publish-export", () => {
  it("makes a fresh repo with one commit, no remote, and none of the private folders", () => {
    const out = join(dir(), "public");
    const r = spawnSync("bash", [SCRIPT, out, "VEMI test export"], { encoding: "utf8" });
    expect(r.stderr + r.stdout).toContain("nothing pushed");
    expect(r.status).toBe(0);
    expect(git(out, "rev-list", "--count", "HEAD").stdout.trim()).toBe("1");
    expect(git(out, "log", "-1", "--format=%s").stdout.trim()).toBe("VEMI test export");
    expect(git(out, "remote").stdout.trim()).toBe("");
    for (const gone of [".works", "data", ".claude", "andy.local.json", ".dev.vars", "AGENTS.md", "CLAUDE.md", "DEPLOY.md"]) expect(existsSync(join(out, gone))).toBe(false);
    expect(existsSync(join(out, "package.json"))).toBe(true);
    expect(existsSync(join(out, "README.md"))).toBe(true);
  }, 240_000);

  it("refuses a folder that is not empty, and one inside the repo", () => {
    const full = dir();
    writeFileSync(join(full, "keep"), "x");
    const notEmpty = spawnSync("bash", [SCRIPT, full], { encoding: "utf8" });
    expect(notEmpty.status).not.toBe(0);
    expect(notEmpty.stderr).toContain("not empty");
    const inside = spawnSync("bash", [SCRIPT, join(resolve(import.meta.dirname, ".."), "export-test-out")], { encoding: "utf8" });
    expect(inside.status).not.toBe(0);
    expect(inside.stderr).toContain("outside the repo");
    expect(existsSync(join(resolve(import.meta.dirname, ".."), "export-test-out"))).toBe(false);
  });
});
