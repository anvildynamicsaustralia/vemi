import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "./walk.js";
import { PHONE } from "../src/web/ui/useMedia.js";

/**
 * The script and the stylesheet agree on what a phone is. The script draws the phone bar in
 * place of the rail and the phone's own Space; the stylesheet sizes every target for a
 * thumb. A sideways phone that one called a phone and the other a desk got the phone bar
 * with desk-sized targets, or the rail with phone-sized ones. Two picker blocks once said
 * 720 where the rest said 719, which is the same fault one pixel wide.
 */
describe("the phone", () => {
  const css = readFileSync(join(ROOT, "src/web/app.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  const queries = [...css.matchAll(/@media ([^{]*)\{/g)].map((m) => (m[1] ?? "").trim());

  it("is one query in every stylesheet block that sizes for it", () => {
    const narrow = queries.filter((q) => q.includes("max-width"));
    expect(narrow.length).toBeGreaterThan(3);
    for (const query of narrow) expect(query).toBe(PHONE);
  });
});
