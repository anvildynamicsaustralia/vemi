import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ value: { step: null, tipsSeen: [] as string[] | null, known: true } }));
vi.mock("../firstRunState.js", async (orig) => ({
  ...(await orig<typeof import("../firstRunState.js")>()),
  useFirstRun: () => state.value,
}));
vi.mock("./useMedia.js", () => ({ PHONE: "", useMedia: () => false }));

import { Tip } from "./Tip.js";

describe("Tip", () => {
  it("draws the line as a button that goes on a tap", () => {
    state.value = { step: null, tipsSeen: [], known: true };
    const out = renderToStaticMarkup(<Tip name="search" />);
    expect(out).toContain('class="tip"');
    expect(out).toContain("Save a search as a filter.");
    expect(out).not.toContain(String.fromCharCode(0x2014));
  });

  it("draws nothing once seen", () => {
    state.value = { step: null, tipsSeen: ["search"], known: true };
    expect(renderToStaticMarkup(<Tip name="search" />)).toBe("");
  });

  it("draws nothing when the account has no tips to show", () => {
    state.value = { step: null, tipsSeen: null, known: true };
    expect(renderToStaticMarkup(<Tip name="search" />)).toBe("");
  });
});
