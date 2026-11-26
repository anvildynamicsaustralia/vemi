import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ConnectAsk } from "./Connect.js";

const ask = (redirectUri: string): string => renderToStaticMarkup(<ConnectAsk name="Claude" redirectUri={redirectUri} />);

describe("the consent page's ask", () => {
  it("shows the site the app returns to beside its name", () => {
    const out = ask("https://claude.ai.evil.example/cb");
    expect(out).toContain("Claude");
    expect(out).toContain("claude.ai.evil.example");
  });
  it("shows no site for an address it cannot read", () => {
    expect(ask("nope")).not.toContain("Returns to");
  });
  it("says what the app can do: read and change, and nothing deleted", () => {
    const out = ask("https://claude.ai/cb");
    expect(out).toContain("wants to read and change your VEMI");
    expect(out).toContain("Cannot delete anything");
  });
});

describe("the Claude mark", () => {
  it("shows with Verified for the exact site claude.ai", () => {
    const out = ask("https://claude.ai/api/mcp/auth_callback");
    expect(out).toContain('aria-label="Claude"');
    expect(out).toContain("Verified");
    expect(out).not.toContain("Not verified");
  });
  it("is never shown for a site that only looks like it", () => {
    const withLogin = ["https://claude.ai", "evil.example/cb"].join(String.fromCharCode(64));
    for (const uri of ["https://claude.ai.evil.example/cb", "https://evil.example/cb", "https://claude.ai:8443/cb", withLogin]) {
      const out = ask(uri);
      expect(out, uri).not.toContain("<svg");
      expect(out, uri).toContain("Not verified");
      expect(out, uri).not.toContain("connect-verified");
    }
  });
  it("gives an unknown app a letter tile", () => {
    expect(ask("https://evil.example/cb")).toContain(">C</div>");
  });
  it("holds no em-dash", () => {
    expect(ask("https://claude.ai/cb")).not.toContain(String.fromCharCode(0x2014));
  });
});
