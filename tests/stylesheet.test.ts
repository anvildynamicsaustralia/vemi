import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { HOLD_MS } from "../src/web/hold.js";
import { PHONE } from "../src/web/ui/useMedia.js";
import { ROOT, walk } from "./walk.js";

/**
 * The stylesheet closes every block it opens. VEMI-004 shipped a phone-only `@media` block
 * with no closing brace, and every rule after it — the delete sheet's among them — quietly
 * applied only below 720px. A browser does not complain; this does.
 */
describe("the stylesheet", () => {
  it("closes every block it opens", () => {
    const css = readFileSync(join(ROOT, "src/web/app.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    let depth = 0;
    let line = 1;
    let negativeAt: number | null = null;
    for (const ch of css) {
      if (ch === "\n") line++;
      if (ch === "{") depth++;
      if (ch === "}") depth--;
      if (depth < 0 && negativeAt === null) negativeAt = line;
    }
    expect(negativeAt).toBeNull();
    expect(depth).toBe(0);
  });

  /**
   * The header says every size has a role, and a raw pixel size outside `:root` is a size
   * without one: the picker, the calendar and the delete sheet had drifted to 12.5px and
   * 13px of their own. A `font:` shorthand is a size too. The one exception is a phone's 16px
   * field, which is not a type role: below it iOS zooms the page into the field when it is
   * focused. It is named here field by field, and only inside the phone's `@media` block,
   * which is the one phone query (tests/phone-query.test.ts). A rule naming several fields
   * passes only when every one of them is named here.
   */
  it("sizes type only from its tokens", () => {
    const PHONE_FIELDS = new Set([
      ".picker-find input", ".delete-confirm .field",
      ".field", ".gate .field", ".editing", ".control-field", ".add-line input",
    ]);
    const css = readFileSync(join(ROOT, "src/web/app.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    // Every declaration with the selector it is under and the blocks around that.
    const raw: string[] = [];
    const preludes: string[] = [];
    let text = "";
    for (const ch of css) {
      if (ch === "{") {
        preludes.push(text.trim());
        text = "";
      } else if (ch === "}" || ch === ";") {
        const [prop, ...rest] = text.split(":");
        const value = rest.join(":").trim();
        const name = prop?.trim() ?? "";
        if ((name === "font-size" || name === "font") && /(^|[\s/])[\d.]+(px|rem|em)\b/.test(value)) {
          const selector = preludes.at(-1) ?? "";
          const phone = preludes.slice(0, -1).some((p) => p === `@media ${PHONE}`);
          const fields = selector.split(",").map((part) => part.trim());
          const allowed = name === "font-size" && value === "16px" && phone && fields.every((f) => PHONE_FIELDS.has(f));
          if (!allowed) raw.push(`${selector} { ${name}: ${value} }`);
        }
        text = "";
        if (ch === "}") preludes.pop();
      } else {
        text += ch;
      }
    }
    expect(raw).toEqual([]);
  });

  /**
   * Every duration is a named token, so reduced motion takes it to zero in one place. Rows
   * sliding under a held one ran 140ms of their own, and the card giving under a held finger
   * 450ms. The `*` override inside reduced motion is the one raw duration, and it is the switch.
   */
  it("times motion only from its tokens", () => {
    const css = readFileSync(join(ROOT, "src/web/app.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    const raw = css.split("\n")
      .filter((line) => /(transition|animation)[^;]*[^\w-][\d.]+m?s\b/.test(line))
      .filter((line) => !line.includes("!important"))
      .map((line) => line.trim());
    expect(raw).toEqual([]);
  });

  it("gives a held card as long as the hold takes to open its menu", () => {
    const css = readFileSync(join(ROOT, "src/web/app.css"), "utf8");
    expect(css.match(/--m-hold:\s*(\d+)ms/)?.[1]).toBe(String(HOLD_MS));
  });
});

/**
 * The phone's status line is one line, centred, with nothing to wrap onto. Offline with
 * writes waiting and a kept copy showing, it said more than a 360px phone holds, and its
 * pieces could not shrink, so it ran off both sides and "No connection", the news it is
 * there for, lost its start. The later pieces give way; the first one never does.
 */
describe("the phone status line", () => {
  const css = readFileSync(join(ROOT, "src/web/app.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  const rule = (selector: string): string => {
    const at = css.indexOf(`${selector} {`);
    expect(at, selector).toBeGreaterThan(-1);
    return css.slice(at, css.indexOf("}", at));
  };

  it("cuts the tail of a long line, never its first piece", () => {
    const piece = rule(".status-line > span");
    expect(piece).toContain("min-width: 0");
    expect(piece).toContain("overflow: hidden");
    expect(piece).toContain("text-overflow: ellipsis");
    expect(rule(".status-line > span:first-child")).toContain("flex-shrink: 0");
  });
});

/** Every innermost rule, as its selectors and its body. */
function rules(): { selectors: string[]; body: string }[] {
  const css = readFileSync(join(ROOT, "src/web/app.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  return [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({
    selectors: (m[1] ?? "").split(",").map((s) => s.trim().replace(/\s+/g, " ")),
    body: m[2] ?? "",
  }));
}

describe("the rules", () => {
  /** Two batches each added `.account-row-actions`, word for word, and both stayed. */
  it("says no rule twice", () => {
    const seen = new Map<string, number>();
    // A keyframe's steps repeat across animations by nature; they are not rules of the page.
    for (const r of rules().filter((r) => !r.selectors.every((s) => /^(from|to|[\d.]+%)$/.test(s)))) {
      const key = `${r.selectors.join(", ")} {${r.body.replace(/\s+/g, " ").trim()}}`;
      seen.set(key, (seen.get(key) ?? 0) + 1);
    }
    expect([...seen].filter(([, n]) => n > 1).map(([key]) => key)).toEqual([]);
  });

  /**
   * Rows put in order by a grip slide aside for the held one, and the held one looks held.
   * The checklist's steps took the grip and neither, so they jumped while one was dragged.
   */
  it("slides and holds every list OrderedRows draws", () => {
    const classes = new Set<string>();
    for (const file of walk("src/web", [".tsx"])) {
      for (const m of readFileSync(join(ROOT, file), "utf8").matchAll(/<OrderedRows\b[^>]*?className="([\w-]+)"/g)) {
        if (m[1] !== undefined) classes.add(m[1]);
      }
    }
    expect(classes.size).toBeGreaterThan(0);
    const all = rules();
    for (const name of classes) {
      const slides = all.some((r) => r.selectors.includes(`.${name}`) && /transition:[^;]*\btransform\b/.test(r.body));
      const held = all.some((r) => r.selectors.includes(`.${name}.held`) && /transition:\s*none/.test(r.body));
      expect(slides, `.${name} slides`).toBe(true);
      expect(held, `.${name}.held`).toBe(true);
    }
  });

  /** The tint is the fill of something chosen. On a hover it says "on" before anything is. */
  it("never fills a hover with the chosen tint", () => {
    const hovers = rules().filter((r) => r.selectors.some((s) => s.includes(":hover")) && r.body.includes("--vemi-live-tint"));
    expect(hovers.map((r) => r.selectors.join(", "))).toEqual([]);
  });

  /**
   * On a phone the status line lifts the selection bar by its height, and a notice stands on
   * the bar. The bar's notice rule outranked the status line's, so with all three up the
   * notice sat over the top of the bar's actions.
   */
  it("stands a notice on a selection bar the status line has lifted", () => {
    const rule = rules().find((r) => r.selectors.includes("body:has(.selection-bar) .page.phone:has(> .status-line) ~ .notice"));
    expect(rule?.body).toMatch(/bottom:\s*calc\([^;]*22px[^;]*var\(--selection-bar-h/);
  });

  /**
   * An empty column has no ⋯, and its head stood 4px shorter than its neighbours': on the
   * board and a project's page the names sat off one line and the empty columns' cards
   * started higher. The tools hold the ⋯'s height less its margins whether it is there or not.
   */
  it("heads a column with no ⋯ as tall as one with it", () => {
    const all = rules();
    const px = (body: string | undefined, prop: string): string | undefined => body?.match(new RegExp(`(?:^|;)\\s*${prop}:\\s*([^;]+)`))?.[1]?.trim();
    const button = Number.parseFloat(px(all.find((r) => r.selectors.length === 1 && r.selectors[0] === ".more-button" && /(^|;)\s*height:/.test(r.body))?.body, "height") ?? "");
    const [top = "", , bottom = top] = (px(all.find((r) => r.selectors.includes(".column-tools .more-button"))?.body, "margin") ?? "").split(/\s+/);
    const tools = px(all.find((r) => r.selectors.includes(".column-tools"))?.body, "height");
    expect(Number.isFinite(button)).toBe(true);
    expect(tools).toBe(`${button + Number.parseFloat(top) + Number.parseFloat(bottom)}px`);
  });

  /**
   * The sign-in card is a column of rows. Its quiet buttons asked to centre their words
   * without being a flex box, so "Forgot password" and "Back to sign in" sat left under a
   * centred "Sign in"; the help link kept the left margin it has in a line of text and stood
   * 8px in from every other row.
   */
  it("centres the sign-in card's buttons and lines its help link up with them", () => {
    const all = rules();
    const quiet = all.find((r) => r.selectors.includes(".gate .quiet-button"))?.body ?? "";
    expect(quiet).toMatch(/display:\s*flex/);
    expect(quiet).toMatch(/justify-content:\s*center/);
    const help = all.find((r) => r.selectors.includes(".gate a.word-button"))?.body ?? "";
    expect(help).toMatch(/margin-left:\s*0/);
    expect(help).toMatch(/justify-content:\s*center/);
  });

  /** A bare field inside a picker has no border of its own, so its row says where the focus is. */
  it("shows the focus on a picker's find row, whose field draws no outline", () => {
    const all = rules();
    const row = all.find((r) => r.selectors.includes(".picker-find:focus-within"))?.body ?? "";
    expect(row).toMatch(/border-bottom-color:\s*var\(--vemi-live\)/);
  });
});
