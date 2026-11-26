import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "./walk.js";

/** The files a public repository carries at its root and in .github. */

const EM_DASH = String.fromCharCode(0x2014);
const FILES = [
  "LICENSE",
  "SECURITY.md",
  "CONTRIBUTING.md",
  "CHANGELOG.md",
  ".github/ISSUE_TEMPLATE/bug.yml",
  ".github/ISSUE_TEMPLATE/idea.yml",
  ".github/ISSUE_TEMPLATE/config.yml",
] as const;

const read = (rel: string): string => (existsSync(join(ROOT, rel)) ? readFileSync(join(ROOT, rel), "utf8") : "");
const flat = (text: string): string => text.replace(/\s+/g, " ").toLowerCase();

describe("repo files", () => {
  it("exist and hold no em-dash", () => {
    for (const f of FILES) {
      expect(existsSync(join(ROOT, f)), f).toBe(true);
      expect(read(f).includes(EM_DASH), `${f} has an em-dash`).toBe(false);
    }
  });

  it("hold no email address", () => {
    for (const f of FILES) expect(read(f), f).not.toMatch(/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+\.[A-Za-z]{2,}/);
  });

  it("LICENSE is MIT and package.json says so", () => {
    const text = read("LICENSE");
    expect(text).toMatch(/^MIT License/);
    expect(text).toContain("Copyright (c) 2026 Anvil Dynamics");
    expect(text).toContain("Permission is hereby granted, free of charge");
    expect(text).toContain('THE SOFTWARE IS PROVIDED "AS IS"');
    expect(JSON.parse(read("package.json")).license).toBe("MIT");
  });

  it("package.json names the public repository, its issues and what the product is", () => {
    const pkg = JSON.parse(read("package.json"));
    const repo = "https://github.com/anvildynamicsaustralia/vemi";
    expect(pkg.repository.url).toContain("anvildynamicsaustralia/vemi");
    expect(pkg.homepage).toContain(repo);
    expect(pkg.bugs.url).toBe(`${repo}/issues`);
    expect(String(pkg.description).length).toBeGreaterThan(20);
    expect(String(pkg.description).includes(EM_DASH)).toBe(false);
    expect(pkg.keywords.length).toBeGreaterThan(2);
  });

  it("SECURITY.md says how to report, that there is no bounty, and what is in scope", () => {
    const text = flat(read("SECURITY.md"));
    expect(text).toContain("private vulnerability report");
    expect(text).toContain("no bounty");
    expect(text).toContain("signing and update path");
    expect(text).toContain("encryption");
    expect(text).toContain("a copy's code");
  });

  it("CONTRIBUTING.md says issues only, how to file, and how to run the checks", () => {
    const text = flat(read("CONTRIBUTING.md"));
    expect(text).toContain("issues only");
    expect(text).toContain("pull requests are not accepted yet");
    for (const w of ["what you did", "what you expected", "what happened", "browser and device", "recovery code", "idea"]) {
      expect(text, w).toContain(w);
    }
    for (const w of ["scripts/check.sh", "node 22", "pnpm", "bash"]) expect(text, w).toContain(w);
  });

  it("the issue templates are forms with labels only, blank issues are off, and the faq is named", () => {
    for (const f of ["bug.yml", "idea.yml"]) {
      const text = read(`.github/ISSUE_TEMPLATE/${f}`);
      expect(text, f).toMatch(/^body:/m);
      expect(text, f).toMatch(/type: textarea/);
      expect(text, f).toMatch(/label: /);
      expect(text, f).not.toMatch(/^\s+(placeholder|value):/m);
    }
    const config = read(".github/ISSUE_TEMPLATE/config.yml");
    expect(config).toMatch(/blank_issues_enabled:\s*false/);
    expect(config).toContain("docs/faq.md");
  });

  it("the changelog's top heading is the package version or the not yet released entry", () => {
    const version = JSON.parse(read("package.json")).version as string;
    const top = read("CHANGELOG.md").split("\n").find((l) => l.startsWith("## "));
    expect(top).toBeDefined();
    expect([`## ${version}`, "## 1.0.0 (not yet released)"]).toContain(top);
  });
});
