import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AccountExtras } from "./AccountExtras.js";
import { Ring } from "./Rings.js";

describe("AccountExtras", () => {
  const out = renderToStaticMarkup(<AccountExtras />);

  it("lists the six Extras, each as a switch that says On or Off", () => {
    for (const title of [
      "Recent list on the map", "Progress rings", "Coming up on Today", "Celebrations",
      "Single-key shortcuts", "Smart dates in Add",
    ]) expect(out).toContain(title);
    expect(out.match(/role="switch"/g)?.length).toBe(6);
    expect(out.match(/>On</g)?.length).toBe(6);
    expect(out.match(/>Off</g)).toBeNull();
  });

  it("has each on by default", () => {
    expect(out.match(/aria-checked="true"/g)?.length).toBe(6);
  });

  it("carries none of the mock's heading sentences", () => {
    expect(out).not.toContain("On by default");
    expect(out).not.toContain("Switch off what you don");
    expect(out).not.toContain("turned this on");
  });

  it("draws a ring while the switch is on", () => {
    expect(renderToStaticMarkup(<Ring size="card" value={3} share={0.5} label="3 left" />)).toContain("ring-card");
  });
});
