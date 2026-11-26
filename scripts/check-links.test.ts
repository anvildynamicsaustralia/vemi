import { afterAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const CHECK = resolve(import.meta.dirname, "check-links.mjs");
const dirs: string[] = [];

function run(files: Record<string, string>): { code: number | null; out: string; err: string } {
  const root = mkdtempSync(join(tmpdir(), "links-"));
  dirs.push(root);
  for (const [name, text] of Object.entries(files)) {
    const full = join(root, name);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, text);
  }
  const r = spawnSync(process.execPath, [CHECK], { cwd: root, encoding: "utf8" });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

describe("link check", () => {
  it("passes a clean tree and lists, without fetching, an absolute link", () => {
    const r = run({
      "README.md": "# Title\n\nSee [docs](docs/index.md#pages) and [site](https://example.com/x).\n\n![logo](docs/logo.svg)\n",
      "docs/index.md": "# Docs\n\n## Pages\n\n- [One](one.md)\n",
      "docs/one.md": "# One\n\nBack to [the index](index.md).\n",
      "docs/logo.svg": "<svg/>",
    });
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    expect(r.out).toContain("https://example.com/x");
  });

  it("passes a tree with no docs folder", () => {
    const r = run({ "README.md": "# Title\n\nPlain text.\n" });
    expect(r.code).toBe(0);
  });

  it("passes a docs folder that holds only pictures", () => {
    const r = run({ "README.md": "# Title\n", "docs/images/one.png": "x" });
    expect(r.code).toBe(0);
  });

  it("catches docs pages with no index", () => {
    const r = run({ "README.md": "# Title\n", "docs/one.md": "# One\n" });
    expect(r.code).not.toBe(0);
    expect(r.err).toContain("docs/index.md");
  });

  it("catches a relative link whose file is missing", () => {
    const r = run({ "README.md": "[gone](docs/nope.md)\n" });
    expect(r.code).not.toBe(0);
    expect(r.err).toContain("README.md:1");
    expect(r.err).toContain("missing file");
  });

  it("catches an anchor with no matching heading", () => {
    const r = run({
      "README.md": "[a](docs/index.md#nothing-here)\n",
      "docs/index.md": "# Docs\n",
    });
    expect(r.code).not.toBe(0);
    expect(r.err).toContain("README.md:1");
    expect(r.err).toContain("no heading");
  });

  it("catches an anchor in the same file with no heading", () => {
    const r = run({ "README.md": "# A\n\n[x](#b)\n" });
    expect(r.code).not.toBe(0);
    expect(r.err).toContain("README.md:3");
  });

  it("catches an image with no alt text", () => {
    const r = run({ "README.md": "![](pic.png)\n", "pic.png": "x" });
    expect(r.code).not.toBe(0);
    expect(r.err).toContain("README.md:1");
    expect(r.err).toContain("alt text");
  });

  it("catches a link to a .works path", () => {
    const r = run({ "README.md": "[plans](.works/board.md)\n", ".works/board.md": "# Board\n" });
    expect(r.code).not.toBe(0);
    expect(r.err).toContain("README.md:1");
    expect(r.err).toContain(".works");
  });

  it("catches a docs page the index does not list", () => {
    const r = run({
      "README.md": "# R\n",
      "docs/index.md": "# Docs\n\n- [One](one.md)\n",
      "docs/one.md": "# One\n",
      "docs/orphan.md": "# Orphan\n",
    });
    expect(r.code).not.toBe(0);
    expect(r.err).toContain("docs/orphan.md");
    expect(r.err).toContain("not listed");
  });

  it("ignores links inside code fences", () => {
    const r = run({ "README.md": "```\n[x](nope.md)\n```\n" });
    expect(r.code).toBe(0);
  });

  it("catches all five faults planted together", () => {
    const r = run({
      "README.md": "[a](missing.md)\n[b](docs/index.md#zzz)\n![](p.png)\n[c](.works/x.md)\n",
      "p.png": "x",
      ".works/x.md": "# X\n",
      "docs/index.md": "# Docs\n",
      "docs/lonely.md": "# Lonely\n",
    });
    expect(r.code).not.toBe(0);
    for (const where of ["README.md:1", "README.md:2", "README.md:3", "README.md:4", "docs/lonely.md"]) {
      expect(r.err, where).toContain(where);
    }
  });
});
