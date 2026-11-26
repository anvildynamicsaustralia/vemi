import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { WANT_OWN, WantYourOwn } from "./WantYourOwn.js";

const out = renderToStaticMarkup(<WantYourOwn busy={false} onExport={() => undefined} />);

describe("the Want your own VEMI card", () => {
  it("offers Export and Get my own VEMI", () => {
    expect(out).toContain("Want your own VEMI?");
    expect(out).toContain(">Export<");
    expect(out).toContain("Get my own VEMI");
  });

  it("opens the helper asking for a file the person picks, carrying nothing", () => {
    expect(out).toContain(`href="${WANT_OWN.href}"`);
    expect(WANT_OWN.href).toBe("/get/?from=old");
  });

  it("never names who runs the copy, and has no em-dash", () => {
    expect(out.toLowerCase()).not.toMatch(/owner|operator|admin|invited|runs this/);
    expect(out).not.toContain(String.fromCharCode(0x2014));
  });

  it("holds no request of its own, so nothing leaves the old copy for the helper", () => {
    const source = readFileSync(new URL("./WantYourOwn.tsx", import.meta.url), "utf8");
    expect(source).not.toMatch(/fetch\(|XMLHttpRequest|sendBeacon|WebSocket|localStorage|\.setItem\(/);
    expect(source).not.toMatch(/from "\.\.\/api\.js"/);
  });
});
