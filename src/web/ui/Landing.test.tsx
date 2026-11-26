import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { LANDING_SHOTS } from "../landingLinks.js";
import { Landing, LANDING_LINE, LANDING_PITCH } from "./Landing.js";

const draw = (flags?: Parameters<typeof Landing>[0]["flags"]): string =>
  renderToStaticMarkup(<Landing onSignIn={() => undefined} flags={flags} />);

/** The words a page of this kind slides into; none belong in this one. */
const HYPE = ["seamless", "empower", "unlock", "leverage", "elevate", "effortless", "supercharge", "all-in-one", "game-changing", "delve", "revolutionary", "cutting-edge"];

describe("Landing", () => {
  it("has the one line as the only h1, its last words in the accent", () => {
    const out = draw();
    expect(out.match(/<h1/g)).toHaveLength(1);
    expect(out).toContain("Everything you&#x27;re building, <em>in one place.</em>");
    expect(out.replace(/<[^>]+>/g, "")).toContain(LANDING_LINE.replace("'", "&#x27;"));
  });
  it("keeps the sub line honest about Claude or ChatGPT", () => {
    expect(LANDING_PITCH).toContain("your own Claude or ChatGPT");
  });
  it("offers Sign in, the three facts, three cards, the maker and the real screens", () => {
    const out = draw();
    expect(out).toContain("Sign in");
    expect(out).toContain("I have an account");
    for (const word of ["Free", "MIT", "Yours", "The map", "Today", "Your own AI", "Run your own copy"]) expect(out).toContain(word);
    expect(out).toContain("Made by Anvil Dynamics");
  });
  it("draws every picture with words, once in the hero, once for each tab and once in the dark block", () => {
    const out = draw();
    const imgs = out.match(/<img [^>]*>/g) ?? [];
    expect(imgs).toHaveLength(2 + LANDING_SHOTS.length + 1);
    for (const img of imgs) expect(img).toMatch(/alt="[^"]{10,}"/);
    for (const shot of LANDING_SHOTS) expect(out).toContain(shot.src);
  });
  it("shows one picture to a reader on each screen and hides the rest", () => {
    const out = draw();
    const hidden = (out.match(/<img [^>]*aria-hidden="true"[^>]*>/g) ?? []).length;
    expect(hidden).toBe(LANDING_SHOTS.length - 2);
  });
  it("has a tab for every screen, each tied to its panel, with only the chosen one in the tab order", () => {
    const out = draw();
    expect(out).toContain("aria-label=\"Desktop screens\"");
    expect(out).toContain("aria-label=\"Phone screens\"");
    expect(out.match(/role="tab"/g)).toHaveLength(8);
    expect(out.match(/role="tab"[^>]*tabindex="0"/g)).toHaveLength(2);
    expect(out.match(/role="tab"[^>]*tabindex="-1"/g)).toHaveLength(6);
    expect(out).toContain("role=\"tabpanel\"");
    expect(out).toContain("aria-controls=\"show-desk-panel\"");
    expect(out).toContain("id=\"show-phone-panel\"");
  });
  it("draws the wordmark in the page's ink, one file for both themes", () => {
    const out = draw();
    expect(out).toContain("<svg");
    expect(out).toContain("aria-label=\"VEMI\"");
    expect(out).toContain("fill=\"currentColor\"");
    expect(out).not.toMatch(/fill="#/);
  });
  it("has the background field hidden from a reader", () => {
    expect(draw()).toMatch(/<div class="landing-bg" aria-hidden="true"><canvas class="landing-field"><\/canvas><\/div>/);
  });
  it("has two info buttons with names, one of them on the dark block", () => {
    const out = draw();
    expect(out).toContain("aria-label=\"About Try it\"");
    expect(out).toContain("aria-label=\"Why Cloudflare\"");
    expect(out).toContain("info-tip on-dark");
    expect(out.match(/class="info-tip-button"/g)).toHaveLength(2);
  });
  it("shows Try it, opening /try, and hides Get your own copy and On GitHub until they have an address", () => {
    const out = draw({ tryShipped: true, getUrl: null, repoUrl: null });
    expect(out).not.toContain("Get your own copy");
    expect(out).not.toContain("Start setup");
    expect(out).toContain("Try it on this device");
    expect(out).toContain("Try it now");
    expect(out).toContain("href=\"/try\"");
    expect(out).not.toContain("On GitHub");
  });
  it("shows the rest once their targets exist, each going to its real place", () => {
    const out = draw({ tryShipped: true, getUrl: "https://get.example.test", repoUrl: "https://github.com/x/y" });
    for (const word of ["Try it on this device", "Get your own copy", "Start setup", "On GitHub"]) expect(out).toContain(word);
    expect(out).toContain("href=\"https://get.example.test/get/\"");
    expect(out).toContain("href=\"https://github.com/x/y\"");
  });
  it("hides every Try it control, and its note, when Try it has not shipped", () => {
    const out = draw({ tryShipped: false, getUrl: null, repoUrl: null });
    for (const word of ["Try it", "Try it keeps", "href=\"/try\""]) expect(out).not.toContain(word);
    expect(out).toContain("Sign in");
  });
  it("uses none of the words that make a page sound written by a machine", () => {
    const text = draw().replace(/<[^>]+>/g, " ").toLowerCase();
    for (const word of HYPE) expect(text, word).not.toContain(word);
  });
  it("has no em-dash", () => expect(draw()).not.toContain(String.fromCharCode(0x2014)));
});

describe("the pictures", () => {
  it("are files that exist, as PNGs under the 300 KB picture cap", () => {
    for (const shot of LANDING_SHOTS) {
      const bytes = readFileSync(join(process.cwd(), "public", shot.src));
      expect(bytes.length, shot.src).toBeLessThan(300 * 1024);
      expect([...bytes.subarray(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
    }
  });
});
