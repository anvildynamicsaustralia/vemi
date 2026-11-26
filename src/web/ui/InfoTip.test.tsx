import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { InfoTip } from "./InfoTip.js";

describe("InfoTip", () => {
  const html = renderToStaticMarkup(<InfoTip label="About Try it">It stays in this browser.</InfoTip>);
  it("is a named button, closed, that points at its note", () => {
    expect(html).toContain('aria-label="About Try it"');
    expect(html).toContain('aria-expanded="false"');
    const id = /aria-controls="([^"]+)"/.exec(html)?.[1] ?? "";
    expect(id).not.toBe("");
    expect(html).toContain(`id="${id}"`);
  });
  it("keeps the note hidden until it is opened, and marks it a note", () => {
    expect(html).toMatch(/role="note"[^>]*hidden/);
  });
  it("can sit on a dark ground", () => {
    expect(renderToStaticMarkup(<InfoTip label="x" tone="on-dark">y</InfoTip>)).toContain("info-tip on-dark");
  });
});
