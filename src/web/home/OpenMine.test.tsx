import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { OpenMine } from "./OpenMine.js";

const draw = (copies: { address: string; last: number }[]): string =>
  renderToStaticMarkup(<OpenMine copies={copies} onChange={() => undefined} />);

describe("Your VEMI on the home page", () => {
  it("asks for an address, labelled, the first time", () => {
    const out = draw([]);
    expect(out).toMatch(/<label class="mine-label" for="([^"]+)">Your VEMI&#x27;s address<\/label><div class="mine-field"><input[^>]* id="\1"/);
    expect(out).toContain('inputMode="url"');
    expect(out).toContain("Open my VEMI");
    expect(out).toContain("Remember it on this device");
  });
  it("opens each known copy at its sign-in in one press, with a named way to forget it", () => {
    const out = draw([{ address: "https://vemi-app.example.com", last: 1 }]);
    expect(out).toContain("Welcome back");
    expect(out).toContain('href="https://vemi-app.example.com/?signin"');
    expect(out).toContain('aria-label="Forget vemi-app.example.com on this device"');
    expect(out).not.toContain("mine-input");
    expect(out).toContain("Open a different VEMI");
  });
});
