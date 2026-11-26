import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AccountAbout } from "./AccountAbout.js";
import { AppContext, type AppActions } from "./appContext.js";

const draw = (owner: boolean): string =>
  renderToStaticMarkup(
    <AppContext.Provider value={{ notify: () => undefined } as unknown as AppActions}>
      <AccountAbout owner={owner} />
    </AppContext.Provider>,
  );

describe("AccountAbout", () => {
  it("shows the owner a Front page switch", () => {
    const out = draw(true);
    expect(out).toContain("Front page");
    expect(out).toContain('role="switch"');
    expect(out).toContain('aria-label="Front page"');
  });

  it("shows the font licences collapsed, with the text not yet loaded", () => {
    const out = draw(false);
    expect(out).toContain("<details");
    expect(out).not.toMatch(/<details[^>]*\sopen/);
    expect(out).toContain("Font licences");
    expect(out).not.toContain("SIL OPEN FONT LICENSE");
  });

  it("offers Run first steps again to every account", () => {
    expect(draw(false)).toContain("Run first steps again");
    expect(draw(true)).toContain("Run first steps again");
  });

  it("in local mode shows the version and nothing about updates or a front page", () => {
    const out = renderToStaticMarkup(
      <AppContext.Provider value={{ notify: () => undefined } as unknown as AppActions}>
        <AccountAbout owner local />
      </AppContext.Provider>,
    );
    expect(out).toContain("Version");
    expect(out).not.toContain("Front page");
    expect(out.toLowerCase()).not.toContain("update");
    expect(out).toContain("Made by");
  });

  it("leaves the Front page row out for everyone else", () => {
    const out = draw(false);
    expect(out).not.toContain("Front page");
    expect(out).toContain("Made by");
  });
});
