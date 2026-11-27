import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { HOME, parseRoute } from "../router.js";
import { PhoneBar, Rail, SkipLink, TopBar } from "./Chrome.js";

const none = (): void => undefined;
const rail = (at: Parameters<typeof Rail>[0]["at"], needs = 0): string => renderToStaticMarkup(<Rail at={at} onGo={none} needs={needs} />);

describe("the rail's items", () => {
  it("keep their names and mark only the current page", () => {
    const out = rail("today");
    for (const name of ["Map", "Today", "Search", "Account"]) expect(out).toContain(`aria-label="${name}"`);
    expect(out.match(/aria-current="page"/g)).toHaveLength(1);
    expect(out).toMatch(/aria-label="Today" aria-current="page"/);
  });

  it("carry a label that shows on focus as well as hover, and is only the section's name", () => {
    const out = rail("map");
    expect(out.match(/class="rail-tip"/g)).toHaveLength(4);
    expect(out).toContain('class="rail-tip" aria-hidden="true">Map');
    const css = readFileSync("src/web/ui/chrome2.css", "utf8");
    expect(css).toMatch(/\.rail-item:hover \.rail-tip, \.rail-item:focus-visible \.rail-tip \{ opacity: 1; \}/);
    expect(css).toMatch(/\.rail-tip \{[^}]*pointer-events: none/);
  });

  it("puts one Tab stop on the rail, on the lit place", () => {
    const stops = (out: string): number => (out.match(/tabindex="0"/g) ?? []).length;
    expect(stops(rail("today"))).toBe(1);
    expect(rail("today")).toMatch(/tabindex="0"[^>]*aria-label="Today"/);
    // A page that is not on the rail (Archive) still leaves one stop, on the first item.
    expect(stops(rail("archive"))).toBe(1);
    expect(rail("archive")).toMatch(/tabindex="0"[^>]*aria-label="Map"/);
  });
});

describe("the needs-you badge", () => {
  it("is drawn with the real number and described to a screen reader", () => {
    const out = rail("map", 3);
    expect(out).toContain('class="place-badge" aria-hidden="true">3<');
    expect(out).toContain("3 need you");
    expect(out).toMatch(/aria-label="Today"[^>]*aria-describedby="rail-needs"/);
  });

  it("is absent for none, and on the phone bar too", () => {
    expect(rail("map", 0)).not.toContain("place-badge");
    const phone = renderToStaticMarkup(<PhoneBar at="map" onGo={none} needs={12} />);
    expect(phone).toContain(">9+<");
    expect(phone).toContain("12 need you");
    expect(renderToStaticMarkup(<PhoneBar at="map" onGo={none} />)).not.toContain("place-badge");
  });
});

describe("the top bar", () => {
  const bar = (path: string, phone: boolean): string =>
    renderToStaticMarkup(<TopBar route={parseRoute(path, "")} ventureName="Shed" itemName="Roof" phone={phone} onGo={none} onSearch={none} />);

  it("says where you are, with earlier steps as links and the page as current", () => {
    const out = bar("/ventures/v1/projects/p1", false);
    expect(out).toContain('aria-label="where you are"');
    expect(out).toContain(">Map</a>");
    expect(out).toContain(">Shed</a>");
    expect(out).toContain('aria-current="page">Roof</span>');
  });

  it("has a search field button with the real palette key shown as a hint", () => {
    const out = bar("/today", false);
    expect(out).toContain('class="search-field"');
    expect(out).toMatch(/aria-keyshortcuts="(Control|Meta)\+K"/);
    expect(out).toMatch(/<kbd class="key-hint" aria-hidden="true">(Ctrl|⌘) K<\/kbd>/);
    expect(bar("/ventures/v1/projects/p1", true)).not.toContain("search-field");
    expect(bar("/ventures/v1/projects/p1", true)).toContain("crumbs");
  });

  it("takes no room on a phone when the trail is one place long", () => {
    expect(bar("/", true)).toBe("");
    expect(bar("/account", true)).toBe("");
    expect(bar("/", false)).toContain("crumbs");
  });

  it("uses a name that cannot be mistaken for the rail's Search", () => {
    expect(bar("/today", false)).not.toMatch(/>Search</);
  });
});

describe("skip to content", () => {
  it("is a real link, off the page until it has focus", () => {
    expect(renderToStaticMarkup(<SkipLink target="main" />)).toContain('<a class="skip-link" href="#main">Skip to content</a>');
    const css = readFileSync("src/web/ui/chrome2.css", "utf8");
    expect(css).toContain(".skip-link:focus-visible");
  });

  it("starts from home as a place the rail knows", () => {
    expect(HOME.surface).toBe("map");
  });
});

describe("the chrome's styles", () => {
  const css = readFileSync("src/web/ui/chrome2.css", "utf8");
  it("clear the notch and take no colour of their own", () => {
    expect(css).toContain("env(safe-area-inset-top)");
    expect(css).not.toMatch(/#[0-9a-fA-F]{3,6}\b|rgba?\(/);
  });
  it("keep the phone bar and page clear of the home indicator", () => {
    const app = readFileSync("src/web/app.css", "utf8");
    expect(app).toMatch(/\.phone-bar \{[^}]*env\(safe-area-inset-bottom\)/);
  });
});
