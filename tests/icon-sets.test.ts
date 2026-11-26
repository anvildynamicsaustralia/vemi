import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT, walk } from "./walk.js";

/**
 * Icons are Lucide (ISC) and Simple Icons (CC0-1.0), and nothing else. Streamline and
 * every CC BY set were considered and refused: attribution is an obligation that would
 * follow this into any shipped copy. And the two sets are drawn differently, so only the
 * icons package reaches for either.
 */

const REFUSED = /streamline|@iconify|font-?awesome|heroicons|phosphor|tabler|feather-icons|react-icons|material-(design-)?icons|remixicon|ionicons|bootstrap-icons|flaticon|icons8/i;

describe("icon sets", () => {
  const manifests = ["package.json", ...walk("src", ["package.json"])];

  it("are Lucide and Simple Icons, and no set that owes attribution", () => {
    const hits: string[] = [];
    for (const file of manifests) {
      const pkg = JSON.parse(readFileSync(join(ROOT, file), "utf8")) as Record<string, Record<string, string> | undefined>;
      const names = [
        ...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.devDependencies ?? {}),
        ...Object.keys(pkg.peerDependencies ?? {}),
      ];
      for (const name of names) if (REFUSED.test(name)) hits.push(`${file} -> ${name}`);
    }
    expect(hits).toEqual([]);
  });

  it("are reached for only by the icons package", () => {
    const hits = walk("src", [".ts", ".tsx"])
      .filter((f) => !f.startsWith("src/icons/"))
      .filter((f) => /from\s+["'](lucide-react|lucide-static|simple-icons)|(lucide-static|simple-icons)[\\/]/.test(readFileSync(join(ROOT, f), "utf8")));
    expect(hits).toEqual([]);
  });
});
