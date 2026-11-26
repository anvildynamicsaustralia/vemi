import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ROOT } from "./walk.js";

/**
 * The headers every page of the app carries, read from `public/_headers`. The Worker's own
 * answers carry the matching set (src/api/securityHeaders.test.ts). A loosening is a failing test.
 */

const text = readFileSync(join(ROOT, "public/_headers"), "utf8");

function rules(source: string): Map<string, Map<string, string>> {
  const out = new Map<string, Map<string, string>>();
  let at: Map<string, string> | null = null;
  for (const line of source.split(/\r?\n/)) {
    if (line.trim() === "") continue;
    if (!line.startsWith(" ")) {
      at = new Map();
      out.set(line.trim(), at);
    } else if (at !== null && !line.trim().startsWith("!")) {
      const i = line.indexOf(":");
      at.set(line.slice(0, i).trim().toLowerCase(), line.slice(i + 1).trim());
    }
  }
  return out;
}

describe("public/_headers", () => {
  const all = rules(text).get("/*") ?? new Map<string, string>();

  it("sets the transport and framing headers on every path", () => {
    expect(all.get("strict-transport-security")).toMatch(/^max-age=\d{8,}$/);
    expect(all.get("x-content-type-options")).toBe("nosniff");
    expect(all.get("referrer-policy")).toBe("no-referrer");
    expect(all.get("x-frame-options")).toBe("DENY");
    expect(all.get("cross-origin-opener-policy")).toBe("same-origin");
  });

  it("turns off the device features the app never uses", () => {
    const policy = all.get("permissions-policy") ?? "";
    for (const feature of ["camera", "microphone", "geolocation", "payment", "usb"]) expect(policy).toContain(`${feature}=()`);
  });

  it("never lets a script run from inline text or eval, anywhere", () => {
    for (const [path, headers] of rules(text)) {
      const csp = headers.get("content-security-policy");
      if (csp === undefined) continue;
      const script = csp.split(";").map((d) => d.trim()).find((d) => d.startsWith("script-src")) ?? "";
      expect(script, path).not.toContain("'unsafe-inline'");
      expect(script, path).not.toContain("'unsafe-eval'");
      expect(csp, path).toContain("frame-ancestors 'none'");
      expect(csp, path).toContain("base-uri 'none'");
      expect(csp, path).toMatch(/default-src '(self|none)'/);
    }
  });
});
