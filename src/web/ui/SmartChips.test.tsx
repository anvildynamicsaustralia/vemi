import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SmartChips } from "./SmartChips.js";

describe("SmartChips", () => {
  it("draws a chip per token", () => {
    const out = renderToStaticMarkup(
      <SmartChips chips={[{ words: "tomorrow", kind: "date" }, { words: "at 3pm", kind: "time" }]} onRestore={() => undefined} />,
    );
    expect(out).toContain("tomorrow");
    expect(out).toContain("at 3pm");
    expect(out.match(/<button/g)).toHaveLength(2);
  });
  it("draws nothing when there are none", () => {
    expect(renderToStaticMarkup(<SmartChips chips={[]} onRestore={() => undefined} />)).toBe("");
  });
  it("never shows typed text as HTML", () => {
    const out = renderToStaticMarkup(<SmartChips chips={[{ words: "<b>x</b>", kind: "date" }]} onRestore={() => undefined} />);
    expect(out).not.toContain("<b>");
  });
});
