import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Me } from "../auth.js";
import { AccountData } from "./AccountData.js";
import { AppContext, type AppActions } from "./appContext.js";

const draw = (local: boolean): string =>
  renderToStaticMarkup(
    <AppContext.Provider value={{ notify: () => undefined } as unknown as AppActions}>
      <AccountData who={null} refresh={async () => undefined} local={local} />
    </AppContext.Provider>,
  );

describe("AccountData in local mode", () => {
  const out = draw(true);

  it("says the data is kept on this device only and links to the setup page", () => {
    expect(out).toContain("Kept on this device only");
    expect(out).toContain('href="/get/?from=local"');
    expect(out).toContain("Move to my own cloud");
  });

  it("keeps Export and the restore control", () => {
    expect(out).toContain("Export everything");
    expect(out).toContain("Restore from a file");
    expect(out).toContain("Archive");
  });

  it("has no em-dash", () => {
    expect(out).not.toContain(String.fromCharCode(0x2014));
  });

  it("offers the card for an existing copy, and no move code", () => {
    expect(out).toContain("I already have a copy");
    expect(out).not.toContain("Make a code");
  });

  it("shows no Clear this device before a move", () => {
    expect(out).not.toContain("Clear this device");
  });

  it("offers a move code to a signed-in account, and no card", () => {
    const signedIn = renderToStaticMarkup(
      <AppContext.Provider value={{ notify: () => undefined } as unknown as AppActions}>
        <AccountData who={{ email: "a@b.c", operator: true } as unknown as Me} refresh={async () => undefined} local={false} />
      </AppContext.Provider>,
    );
    expect(signedIn).toContain("Make a code");
    expect(signedIn).not.toContain("I already have a copy");
  });

  it("leaves the signed-in screen without the line or the link", () => {
    const cloud = draw(false);
    expect(cloud).not.toContain("Kept on this device only");
    expect(cloud).not.toContain("Move to my own cloud");
    expect(cloud).toContain("Export everything");
  });
});

describe("AccountData for an invited account", () => {
  const asWho = (operator: boolean): string =>
    renderToStaticMarkup(
      <AppContext.Provider value={{ notify: () => undefined } as unknown as AppActions}>
        <AccountData who={{ email: "a@b.c", operator } as unknown as Me} refresh={async () => undefined} local={false} />
      </AppContext.Provider>,
    );

  it("shows an invited account the card, with Export beside it", () => {
    const invited = asWho(false);
    expect(invited).toContain("Want your own VEMI?");
    expect(invited).toContain('href="/get/?from=old"');
    expect(invited).toContain("Export everything");
  });

  it("never shows the owner or local mode the card", () => {
    expect(asWho(true)).not.toContain("Want your own VEMI?");
    expect(draw(true)).not.toContain("Want your own VEMI?");
  });
});
