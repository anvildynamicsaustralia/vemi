import { describe, expect, it } from "vitest";
import { consentBody, readConnectRequest, returnSite, verifiedMark } from "./connectRequest.js";

describe("consentBody", () => {
  const request = { clientId: "c_1", redirectUri: "https://a.example/cb", codeChallenge: "abc", state: "s", resource: "https://v.example/mcp" };
  it("sends the request back whole with the answer", () => {
    expect(consentBody(request, "allow")).toEqual({ decision: "allow", ...request });
    expect(consentBody(request, "deny").decision).toBe("deny");
  });
  it("leaves out a state or resource the app never sent", () => {
    const body = consentBody({ ...request, state: null, resource: null }, "allow");
    expect(body).toEqual({ decision: "allow", clientId: "c_1", redirectUri: "https://a.example/cb", codeChallenge: "abc" });
  });
});

describe("readConnectRequest", () => {
  it("reads a whole request", () => {
    const r = readConnectRequest("?client_id=c_1&redirect_uri=https%3A%2F%2Fa.example%2Fcb&code_challenge=abc&state=s&resource=https%3A%2F%2Fv.example%2Fmcp");
    expect(r).toEqual({ clientId: "c_1", redirectUri: "https://a.example/cb", codeChallenge: "abc", state: "s", resource: "https://v.example/mcp" });
  });
  it("keeps state and resource null when absent", () => {
    expect(readConnectRequest("?client_id=c&redirect_uri=r&code_challenge=x")).toMatchObject({ state: null, resource: null });
  });
  it("refuses a request missing who, where or the challenge", () => {
    expect(readConnectRequest("")).toBeNull();
    expect(readConnectRequest("?client_id=c&redirect_uri=r")).toBeNull();
    expect(readConnectRequest("?redirect_uri=r&code_challenge=x")).toBeNull();
  });
});

describe("returnSite", () => {
  it("names the site an app sends the person back to", () => {
    expect(returnSite("https://claude.example/api/mcp/auth_callback")).toBe("claude.example");
    expect(returnSite("https://claude.example:8443/cb")).toBe("claude.example:8443");
    expect(returnSite("http://localhost:6274/oauth/callback")).toBe("localhost:6274");
  });
  it("shows the real site of an address built to read like another", () => {
    expect(returnSite("https://claude.ai.evil.example/cb")).toBe("claude.ai.evil.example");
    // A name before an at-sign is a login in a web address, not part of the site.
    const withLogin = ["https://claude.ai", "evil.example/cb"].join(String.fromCharCode(64));
    expect(returnSite(withLogin)).toBe("evil.example");
  });
  it("has none for what is not a safe web address", () => {
    expect(returnSite("javascript:alert(1)")).toBeNull();
    expect(returnSite("http://evil.example/cb")).toBeNull();
    expect(returnSite("not an address")).toBeNull();
  });
});

describe("verifiedMark", () => {
  it("names Claude for the exact site claude.ai and nothing else", () => {
    expect(verifiedMark(returnSite("https://claude.ai/api/mcp/auth_callback"))).toBe("claude");
    expect(verifiedMark("claude.ai")).toBe("claude");
  });
  it("gives no mark to a site built to read like it", () => {
    const withLogin = ["https://claude.ai", "evil.example/cb"].join(String.fromCharCode(64));
    for (const uri of [
      "https://claude.ai.evil.example/cb", "https://evil.example/cb", "https://claude.ai:8443/cb", "https://www.claude.ai/cb",
      "https://notclaude.ai/cb", "https://claude.ai.example/cb", "https://claude.ai./cb", withLogin, "https://claude.com/cb",
    ]) {
      expect(verifiedMark(returnSite(uri)), uri).toBeNull();
    }
  });
  it("gives none for a site it was not given, or one in another case or with a path", () => {
    expect(verifiedMark(null)).toBeNull();
    expect(verifiedMark("")).toBeNull();
    expect(verifiedMark("Claude.AI")).toBeNull();
    expect(verifiedMark("claude.ai/")).toBeNull();
    expect(verifiedMark(" claude.ai")).toBeNull();
    expect(verifiedMark("claude.ai:8443")).toBeNull();
  });
});
