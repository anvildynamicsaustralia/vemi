import { describe, expect, it } from "vitest";
import { TOKEN_NAME, TOKEN_PERMISSIONS, tokenLink } from "./tokenLink.js";

describe("the pre-filled token address", () => {
  it("is pinned to the dashboard link, the name and the fewest permissions", () => {
    expect(tokenLink()).toBe(
      "https://dash.cloudflare.com/?to=/:account/api-tokens" +
        "&permissionGroupKeys=%5B%7B%22key%22%3A%22workers_scripts%22%2C%22type%22%3A%22edit%22%7D%2C%7B%22key%22%3A%22d1%22%2C%22type%22%3A%22edit%22%7D%2C%7B%22key%22%3A%22account_settings%22%2C%22type%22%3A%22read%22%7D%5D" +
        "&name=VEMI%20setup",
    );
  });

  it("names the token VEMI setup and carries its permissions as the JSON Cloudflare reads", () => {
    const url = new URL(tokenLink());
    expect(TOKEN_NAME).toBe("VEMI setup");
    expect(url.searchParams.get("name")).toBe("VEMI setup");
    expect(url.searchParams.get("to")).toBe("/:account/api-tokens");
    expect(JSON.parse(url.searchParams.get("permissionGroupKeys")!)).toEqual(TOKEN_PERMISSIONS);
  });

  it("asks for nothing that deletes or manages other keys", () => {
    expect(TOKEN_PERMISSIONS.map((p) => p.key)).not.toContain("account_api_tokens");
    expect(TOKEN_PERMISSIONS.filter((p) => p.type === "edit").map((p) => p.key)).toEqual(["workers_scripts", "d1"]);
  });
});
