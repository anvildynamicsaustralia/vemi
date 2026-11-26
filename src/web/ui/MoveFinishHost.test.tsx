import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MoveFinishHost } from "./MoveFinishHost.js";

afterEach(() => vi.unstubAllGlobals());

const shelf = (held: string | null) => ({ getItem: () => held, setItem: () => {}, removeItem: () => {} });

describe("MoveFinishHost", () => {
  it("draws nothing when no move left a finishing pass to run", () => {
    vi.stubGlobal("localStorage", shelf(null));
    expect(renderToStaticMarkup(<MoveFinishHost />)).toBe("");
  });

  it("asks for the export file when a move left a finishing pass to run", () => {
    vi.stubGlobal("localStorage", shelf(JSON.stringify({ v: 1, ids: {} })));
    const html = renderToStaticMarkup(<MoveFinishHost />);
    expect(html).toContain("Your export file");
    expect(html).toContain('type="file"');
    expect(html).not.toContain(String.fromCharCode(0x2014));
  });
});
