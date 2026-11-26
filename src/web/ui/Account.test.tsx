import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { visibleSections } from "../accountSections.js";
import { AccountLayout } from "./Account.js";
import { PrivacySection } from "./AccountPrivacy.js";

const draw = (owner: boolean, open: Parameters<typeof AccountLayout>[0]["open"], phone: boolean): string =>
  renderToStaticMarkup(
    <AccountLayout shown={visibleSections({ owner })} open={open} phone={phone} onOpen={() => undefined} panel={<p>PANEL</p>} />,
  );

describe("AccountLayout", () => {
  it("shows a side list and a panel on a desk", () => {
    const out = draw(true, "profile", false);
    expect(out).toContain("Profile and sign-in");
    expect(out).toContain("People");
    expect(out).toContain("PANEL");
    expect(out).not.toContain("account-phone");
    expect(out).not.toContain("‹ Account");
  });

  it("shows only the list on a phone until a section is opened", () => {
    const out = draw(true, null, true);
    expect(out).toContain("account-phone");
    expect(out).toContain("Your data");
    expect(out).not.toContain("PANEL");
  });

  it("opens one section under a back link on a phone", () => {
    const out = draw(false, "about", true);
    expect(out).toContain("‹ Account");
    expect(out).toContain("PANEL");
    expect(out).not.toContain("Profile and sign-in");
  });

  it("leaves People out of a non-owner's list and keeps Privacy and security", () => {
    const out = draw(false, "profile", false);
    expect(out).not.toContain(">People<");
    expect(out).toContain("Privacy and security");
  });
});

describe("Privacy and security panel", () => {
  const panel = (owner: boolean) => (
    <PrivacySection owner={owner} appLock={<div>App lock</div>}><p>ROWS</p></PrivacySection>
  );
  for (const phone of [false, true]) {
    it(`shows where data is kept and the rows ${phone ? "on a phone" : "on a desk"}`, () => {
      const out = renderToStaticMarkup(
        <AccountLayout shown={visibleSections({ owner: false })} open="privacy" phone={phone} onOpen={() => undefined} panel={panel(false)} />,
      );
      expect(out).toContain("run by the person who invited you");
      expect(out).toContain("ROWS");
      expect(out).toContain("App lock");
    });
  }
});
