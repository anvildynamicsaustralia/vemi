import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT, walk } from "./walk.js";

/**
 * The setup page at `/get/` stands apart from the app (setup-helper, Task 6): its own entry, the
 * app's tokens, fonts and icons, none of the app's code, none of its routes. And its policy adds
 * one thing to the site's: the new copy's `workers.dev` address, where the key is handed over.
 */

const read = (path: string): string => readFileSync(join(ROOT, path), "utf8");
const code = (text: string): string => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

/** The `_headers` rules, by path pattern. */
function rules(text: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  let at: string | null = null;
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    if (!line.startsWith(" ")) {
      at = line.trim();
      out.set(at, []);
    } else if (at !== null) {
      out.get(at)?.push(line.trim());
    }
  }
  return out;
}

const directive = (policy: string, name: string): string[] =>
  (policy.split(";").map((d) => d.trim()).find((d) => d.startsWith(`${name} `))?.slice(name.length + 1).split(/\s+/)) ?? [];

describe("the setup page's entry", () => {
  const page = read("get/index.html");

  it("is its own page that loads the setup script and nothing of the app's", () => {
    expect(page.match(/<script[^>]*src="([^"]+)"/g)).toHaveLength(1);
    expect(page).toContain('src="/src/web/get/main.tsx"');
    expect(page).not.toContain("/src/web/main.tsx");
    expect(page).not.toContain("manifest");
  });

  it("is built as a second entry beside the app's", () => {
    const config = read("vite.config.ts");
    expect(config).toMatch(/input:\s*{[^}]*main:[^}]*index\.html[^}]*get:[^}]*get\/index\.html/);
  });

  it("has no em-dash", () => expect(page.includes(String.fromCharCode(0x2014))).toBe(false));
});

describe("the setup page's code", () => {
  const files = walk("src/web/get", [".ts", ".tsx"]).filter((f) => !f.includes(".test."));

  it("imports the app's tokens, fonts and icons, and no app code", () => {
    const main = code(read("src/web/get/main.tsx"));
    expect(main).toContain('"../app.css"');
    expect(main).toContain("@fontsource-variable/archivo");
    expect(read("src/web/get/GetFlow.tsx")).toContain('from "@vemi/icons"');
    // The one exception, from the redesign: ui/InfoTip, the small i and its note, which the pages before
    // the app share. The next test holds that file to React and its own stylesheet.
    const banned = /from "\.\.\/(App|api|auth|state)\b|from "\.\.\/ui\/(?!InfoTip\.js")/;
    for (const file of files) expect(code(read(file)), file).not.toMatch(banned);
    expect(code(read("src/web/get/GetFlow.tsx"))).toContain('from "../ui/InfoTip.js"');
  });

  it("takes from ui only InfoTip, which imports nothing but React and its own stylesheet", () => {
    const imports = [...code(read("src/web/ui/InfoTip.tsx")).matchAll(/^import [^;]*? from "([^"]+)";|^import "([^"]+)";/gm)].map((m) => m[1] ?? m[2]);
    expect(imports.sort()).toEqual(["./infotip.css", "react"]);
    expect(code(read("src/web/ui/infotip.css"))).not.toMatch(/@import|url\(/);
  });

  it("calls no route of the app", () => {
    for (const file of files) {
      const text = code(read(file));
      expect(text, file).not.toMatch(/["'`]\/(api|auth|mcp|oauth)\b/);
    }
  });

  it("registers no service worker", () => {
    for (const file of files) expect(code(read(file)), file).not.toContain("serviceWorker");
  });

  it("keeps the key and the claim code out of every storage", () => {
    for (const file of files) {
      const text = code(read(file));
      expect(text, file).not.toMatch(/localStorage|indexedDB|document\.cookie/);
    }
    // The one storage write is the saved text, which is built from the step, name and address only.
    const flow = code(read("src/web/get/GetFlow.tsx"));
    expect(flow.match(/\.setItem\(/g)).toHaveLength(1);
    expect(flow).toContain("setItem(SAVED_KEY, text)");
  });

  it("keeps the pure modules pure", () => {
    for (const file of ["src/shared/setup/getFlow.ts", "src/web/get/getFlowState.ts"]) {
      const text = code(read(file));
      expect(text, file).not.toMatch(/\bfetch\(|window\.|document\.|sessionStorage|Date\.now|setTimeout|Math\.random/);
    }
  });
});

describe("the setup page's policy", () => {
  const headers = rules(read("public/_headers"));
  const site = (headers.get("/*") ?? []).find((l) => l.startsWith("Content-Security-Policy:"))?.slice("Content-Security-Policy:".length).trim() ?? "";
  const get = (headers.get("/get/*") ?? []).find((l) => l.startsWith("Content-Security-Policy:"))?.slice("Content-Security-Policy:".length).trim() ?? "";

  it("replaces the site's policy for /get/*, so the two do not both apply", () => {
    expect(headers.get("/get/*")).toContain("! Content-Security-Policy");
    expect(get).not.toBe("");
  });

  it("changes only connect-src from the site's policy, to the page itself and the new copy's address", () => {
    const names = (policy: string): string[] => policy.split(";").map((d) => d.trim().split(" ")[0] ?? "").filter(Boolean);
    expect(names(get)).toEqual(names(site));
    for (const name of names(site)) {
      const before = directive(site, name);
      const after = directive(get, name);
      if (name === "connect-src") expect(after).toEqual(["'self'", "https://*.workers.dev"]);
      else expect(after, name).toEqual(before);
    }
  });

  it("keeps the page out of every frame and talks to Cloudflare through the relay, not directly", () => {
    expect(directive(get, "frame-ancestors")).toEqual(["'none'"]);
    expect(directive(get, "connect-src")).not.toContain("https://api.cloudflare.com");
    expect(directive(get, "connect-src")).not.toContain("https://api.github.com");
    expect(directive(get, "script-src")).toEqual(["'self'"]);
  });
});
