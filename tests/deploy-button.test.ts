/**
 * The deploy button (VEMI-013 self-host). The README opens with the Deploy to Cloudflare button,
 * and the `build` and `deploy` scripts are what that button runs on a stranger's account. If the
 * button URL or the scripts drift, a copy's owner gets a broken deploy, so this fails first.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ROOT } from "./walk.js";

const readme = readFileSync(join(ROOT, "README.md"), "utf8");
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { scripts: Record<string, string> };

const BUTTON_URL = "https://deploy.workers.cloudflare.com/?url=https://github.com/anvildynamicsaustralia/vemi";

describe("the README button", () => {
  it("is the first link in the README, and points at the deploy URL", () => {
    const first = readme.match(/\[!\[[^\]]*\]\([^)]*\)\]\(([^)]*)\)/);
    expect(first?.[1]).toBe(BUTTON_URL);
    // Only the button's own image link comes before it.
    const before = readme.slice(0, readme.indexOf(BUTTON_URL));
    expect(before.split("](http").length - 1).toBe(1);
  });

  it("uses the Cloudflare button image", () => {
    expect(readme).toContain("![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)");
  });

  it("gives the owner of a copy the three steps, in order", () => {
    const deploy = readme.indexOf("1. Deploy");
    const open = readme.indexOf("2. Open the address");
    const account = readme.indexOf("3. Make the first account");
    expect(deploy).toBeGreaterThan(-1);
    expect(open).toBeGreaterThan(deploy);
    expect(account).toBeGreaterThan(open);
  });

  it("holds no em-dash", () => {
    expect(readme).not.toContain("—");
  });
});

describe("the scripts the button runs", () => {
  it("builds the client, then dry-runs the Worker", () => {
    expect(pkg.scripts.build).toBe("vite build && wrangler deploy --dry-run --outdir dist/worker");
  });

  it("deploys by applying migrations to the D1 binding DB, then deploying", () => {
    expect(pkg.scripts.deploy).toBe("wrangler d1 migrations apply DB --remote && wrangler deploy");
  });
});
