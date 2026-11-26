import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AddLine } from "./controls.js";

describe("AddLine", () => {
  it("draws the same line with or without smart reading until something is read", () => {
    const plain = renderToStaticMarkup(<AddLine placeholder="a task" onAdd={() => undefined} />);
    const smart = renderToStaticMarkup(<AddLine placeholder="a task" smart onAdd={() => undefined} />);
    expect(smart).toBe(plain);
    expect(smart).not.toContain("read from the title");
  });
});
