import { afterAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const SCAN = resolve(import.meta.dirname, "..", "scripts", "scan-em-dash.mjs");
const DASH = "—";
const REASON = "no em-dash in a user-facing string";
const dirs: string[] = [];

function run(files: Record<string, string>): { code: number | null; err: string } {
  const root = mkdtempSync(join(tmpdir(), "emdash-"));
  dirs.push(root);
  for (const [name, text] of Object.entries(files)) {
    const full = join(root, name);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, text);
  }
  const r = spawnSync(process.execPath, [SCAN], { cwd: root, encoding: "utf8" });
  return { code: r.status, err: r.stderr };
}

afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

describe("em-dash scan", () => {
  it("reports a plain string with file:line and the reason, and exits non-zero", () => {
    const r = run({ "src/web/a.ts": `const a = 1;\nconst s = "one ${DASH} two";\n` });
    expect(r.code).not.toBe(0);
    expect(r.err).toContain(`src/web/a.ts:2: ${REASON}`);
  });

  it("reports a string after a glob literal on the same line", () => {
    const r = run({ "src/web/a.ts": `const g = import.meta.glob("../d/*.md"); const s = "a ${DASH} b";\n` });
    expect(r.code).not.toBe(0);
    expect(r.err).toContain(`src/web/a.ts:1: ${REASON}`);
  });

  it("reports a string on the line after a glob literal", () => {
    const r = run({ "src/web/a.ts": `const g = import.meta.glob("../d/*.md");\nconst s = "a ${DASH} b";\n` });
    expect(r.code).not.toBe(0);
    expect(r.err).toContain(`src/web/a.ts:2: ${REASON}`);
  });

  it("does not report an em-dash in a line or block comment", () => {
    const r = run({
      "src/web/a.ts": `// line ${DASH} comment\n/* block ${DASH}\n still ${DASH} */\nconst ok = 1; // tail ${DASH}\n`,
    });
    expect(r.code).toBe(0);
    expect(r.err).toBe("");
  });

  it("reports an em-dash in a markdown doc, every line counting", () => {
    const r = run({ "docs/a.md": `fine\n\nsays ${DASH} this\n` });
    expect(r.code).not.toBe(0);
    expect(r.err).toContain(`docs/a.md:3: ${REASON}`);
  });

  it("reports an em-dash in index.html and public text files", () => {
    const r = run({
      "index.html": `<p>a ${DASH} b</p>\n`,
      "public/manifest.webmanifest": `{"name": "a ${DASH} b"}\n`,
    });
    expect(r.code).not.toBe(0);
    expect(r.err).toContain(`index.html:1: ${REASON}`);
    expect(r.err).toContain(`public/manifest.webmanifest:1: ${REASON}`);
  });
});

describe("em-dash scan, the public docs", () => {
  const dash = String.fromCharCode(0x2014);
  it("reports an em-dash in README.md, a root markdown file, docs/ and .github/", () => {
    const files = ["README.md", "CONTRIBUTING.md", "docs/guide/page.md", ".github/ISSUE_TEMPLATE/bug.md", ".github/workflows/ci.yml"];
    const r = run(Object.fromEntries(files.map((f) => [f, `a ${dash} b\n`])));
    expect(r.code).not.toBe(0);
    for (const f of files) expect(r.err, f).toContain(`${f}:1: ${REASON}`);
  });

  it("leaves the internal root files and .works alone", () => {
    const r = run({ "AGENTS.md": `a ${dash} b\n`, ".works/x.md": `a ${dash} b\n`, "README.md": "fine\n" });
    expect(r.code).toBe(0);
  });
});
