/**
 * The release scan must catch every kind of leak it names, and let the one allowed address through.
 * The script plants one of each in a temp tree itself (--self-test); this runs it so a vitest run
 * fails the moment the scan stops catching one.
 */
import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const SCAN = resolve(import.meta.dirname, "..", "scripts", "release-scan.sh");

describe("release scan self-test", () => {
  it("catches each planted leak and passes the allowed address", () => {
    const r = spawnSync("bash", [SCAN, "--self-test"], { encoding: "utf8" });
    expect(r.stdout + r.stderr).toContain("SELF-TEST PASSED");
    expect(r.status).toBe(0);
  });
});

describe("release scan output", () => {
  it("names the file and line of a leak and never prints its value, even in a one-file tree", () => {
    const dir = mkdtempSync(join(tmpdir(), "vemi-scan-"));
    try {
      const value = `cfut_${"a1b2c3d4".repeat(5)}`;
      writeFileSync(join(dir, "only.txt"), `key = ${value}\n`);
      const r = spawnSync("bash", [SCAN, dir], { encoding: "utf8" });
      expect(r.status).toBe(1);
      expect(r.stdout).toContain("only.txt:1");
      expect(r.stdout + r.stderr).not.toContain(value);
      expect(r.stdout + r.stderr).not.toContain("a1b2c3d4");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
