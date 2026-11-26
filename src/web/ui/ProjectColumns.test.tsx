import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ProjectColumns } from "./ProjectColumns.js";

describe("ProjectColumns", () => {
  const out = renderToStaticMarkup(
    <ProjectColumns main={<p>the main column</p>} side={<p>the side column</p>} />,
  );

  it("puts the main column first and the side column after it", () => {
    expect(out.indexOf("the main column")).toBeGreaterThan(-1);
    expect(out.indexOf("the main column")).toBeLessThan(out.indexOf("the side column"));
    expect(out).toMatch(/<div class="pjmain"><p>the main column<\/p><\/div><div class="pjside"><p>the side column<\/p><\/div>/);
  });

  it("is one grid that the stylesheet makes two columns on a desk and one on a phone", () => {
    expect(out).toMatch(/^<div class="pj">/);
  });
});
