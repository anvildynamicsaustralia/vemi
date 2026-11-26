import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readJsonc } from "./jsonc.js";
import { ROOT } from "./walk.js";

/**
 * The move never touches a middleman (move-to-cloud, Task 9). The document and the password go
 * to the new copy and nowhere else, so the code that moves them names no front door, no relay and
 * no host of its own; the new copy's address comes in as an argument. A copy not built by the
 * helper has the move's door shut: `SETUP_FROM` is never in the committed config.
 */

const read = (path: string): string => readFileSync(join(ROOT, path), "utf8");

/** Source with comments removed, so a sentence that explains the rule does not trip it. */
const code = (text: string): string => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

/** Every file that sends, or builds the address of, the move. */
const MOVE_CODE = [
  "src/web/moveToCloud.ts",
  "src/web/moveIntoCopy.ts",
  "src/web/get/MoveBuild.tsx",
  "src/web/get/MoveDone.tsx",
  "src/shared/setup/getFlow.ts",
];

describe("the move's code", () => {
  for (const file of MOVE_CODE) {
    it(`${file} names no front door, no relay and no hard-coded host`, () => {
      const text = code(read(file));
      expect(text).not.toMatch(/vemi-front/);
      expect(text).not.toMatch(/\/get\/relay/);
      const hosts = [...text.matchAll(/https?:\/\/[^\s"'`)]+/g)].map((m) => m[0]);
      // The deploy button's link is the one address the helper page holds; it is a link the person opens, not a call.
      expect(hosts.filter((h) => !h.startsWith("https://deploy.workers.cloudflare.com/") && !h.startsWith("https://dash.cloudflare.com/") && !h.startsWith("https://github.com/")), file).toEqual([]);
    });
  }

  it("sends only through the address it was given", () => {
    const text = code(read("src/web/moveToCloud.ts"));
    expect(text.match(/\bdoFetch\(/g)).toHaveLength(1);
    expect(text).toContain("doFetch(moveAddress(input.address)");
  });
});

describe("the copy's committed config", () => {
  it("does not set SETUP_FROM, so a copy the helper did not build has the door shut", () => {
    const config = readJsonc<{ vars?: Record<string, unknown> }>("wrangler.jsonc");
    expect(Object.keys(config.vars ?? {})).not.toContain("SETUP_FROM");
    expect(read("wrangler.jsonc")).not.toMatch(/SETUP_FROM\s*["']?\s*:/);
  });
});

describe("the headers", () => {
  const blocks = new Map<string, string>();
  let at = "";
  for (const line of read("public/_headers").split(/\r?\n/)) {
    if (/^\S/.test(line)) at = line.trim();
    else if (line.trim().startsWith("Content-Security-Policy:")) blocks.set(at, line.trim().slice("Content-Security-Policy:".length).trim());
  }
  const connect = (path: string): string[] => {
    const directive = (blocks.get(path) ?? "").split(";").map((d) => d.trim()).find((d) => d.startsWith("connect-src "));
    return directive === undefined ? [] : directive.split(" ").slice(1);
  };

  it("keeps /try strict: it can reach only itself", () => {
    expect(connect("/try/*")).toEqual(["'self'"]);
  });

  it("lets the move's page reach itself and a workers.dev copy, and nothing else", () => {
    expect(connect("/get/*")).toEqual(["'self'", "https://*.workers.dev"]);
  });
});
