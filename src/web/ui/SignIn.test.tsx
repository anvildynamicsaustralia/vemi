import { renderToStaticMarkup } from "react-dom/server";
import { PASSWORD_MIN } from "@vemi/shared";
import { describe, expect, it } from "vitest";
import { ClaimForm, InviteOnly, SignIn } from "./SignIn.js";

const noop = (): void => undefined;

const card = (claimable: boolean): string =>
  renderToStaticMarkup(
    <SignIn googleReady={false} claimable={claimable} signedIn={false} link={null} notice={null} onLeave={noop} onSignedIn={async () => undefined} />,
  );

const form = (password = "", again = ""): string =>
  renderToStaticMarkup(
    <ClaimForm email="" password={password} again={again} busy={false} error={null}
      onEmail={noop} onPassword={noop} onAgain={noop} onBack={noop} onSubmit={noop} />,
  );

describe("the sign-in page", () => {
  it("is the split page: the wordmark and a headline on one side, the form on the other", () => {
    const out = card(false);
    expect(out).toContain("gate-side");
    expect(out).toContain('aria-label="VEMI"');
    expect(out).toContain("<em>everything</em>");
    expect(out).toContain("<h1");
    // "Welcome back" is for someone who has signed in on this browser before.
    expect(out).toContain(">Sign in</h1>");
  });
  it("keeps the names its fields always had", () => {
    const out = card(false);
    expect(out).toContain('aria-label="Email"');
    expect(out).toContain('aria-label="Password"');
    expect(out).toContain('autoComplete="email"');
    expect(out).toContain('autoComplete="current-password"');
  });
  it("labels each field in view and ties the label to it", () => {
    const out = card(false);
    expect(out).toMatch(/<label for="([^"]+)">Email<\/label><\/div><input[^>]* id="\1"/);
  });
  it("puts Forgot password beside Password, as a link anyone expects, and no small note", () => {
    const out = card(false);
    expect(out).not.toContain("info-tip-button");
    expect(out).toMatch(/>Password<\/label><span class="gate-aside"><button type="button" class="quiet-button">Forgot password\?<\/button>/);
  });
  it("lets the password be shown, and says which", () => {
    const out = card(false);
    expect(out).toContain('aria-pressed="false"');
    expect(out).toContain('aria-label="Show password"');
  });
});

describe("sign-up on a copy with no accounts", () => {
  it("offers the owner account from the sign-in card", () => {
    const out = card(true);
    expect(out).toContain("Create the owner account");
    expect(out).not.toContain("Sign up");
  });
  it("asks for an email and the password twice", () => {
    const out = form();
    expect(out).toContain('aria-label="Email"');
    expect(out).toContain('aria-label="Password"');
    expect(out).toContain('aria-label="Password again"');
    expect(out).toContain("Create the owner account");
    expect(out).not.toContain("invite only");
  });
  it("says the password rule the Worker holds, and nothing more than it", () => {
    expect(form()).toContain(`At least ${PASSWORD_MIN} characters.`);
    expect(form()).not.toMatch(/Strong|symbol|uppercase|number/i);
  });
  it("says Matches only when the two are the same, and says so when they are not", () => {
    expect(form()).not.toContain("Matches");
    expect(form("a long enough one", "a long enough one")).toContain("Matches");
    const apart = form("a long enough one", "something else");
    expect(apart).not.toContain("Matches");
    expect(apart).toContain("The two passwords are not the same.");
  });
});

describe("sign-up on a copy that has an owner", () => {
  it("leaves the sign-in card with a Sign up way in, and no owner account", () => {
    const out = card(false);
    expect(out).toContain("Sign up");
    expect(out).not.toContain("Create the owner account");
  });
  it("says the copy is invite only, with a way back to sign in and nothing else", () => {
    const out = renderToStaticMarkup(<InviteOnly onSignIn={noop} />);
    expect(out).toContain("This copy is invite only");
    expect(out).toContain("Sign in");
    expect(out).not.toContain("<input");
    expect(out).not.toContain("Google");
    expect(out.match(/<button/g)).toHaveLength(1);
  });
  it("has no em-dash on any of the screens", () => {
    const dash = String.fromCharCode(0x2014);
    expect(renderToStaticMarkup(<InviteOnly onSignIn={noop} />)).not.toContain(dash);
    expect(form()).not.toContain(dash);
    expect(card(true)).not.toContain(dash);
    expect(card(false)).not.toContain(dash);
  });
});
