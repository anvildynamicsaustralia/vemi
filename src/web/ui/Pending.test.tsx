import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Pending } from "./controls.js";

describe("Pending", () => {
  it("announces a failed read, so a screen reader hears it arrive", () => {
    const html = renderToStaticMarkup(<Pending error="Could not reach VEMI." onRetry={() => undefined} />);
    expect(html).toContain('<span role="alert">Could not reach VEMI.</span>');
    expect(html).toContain("Try again");
  });

  it("is quiet while it is only loading", () => {
    const html = renderToStaticMarkup(<Pending error={null} onRetry={() => undefined} />);
    expect(html).not.toContain("alert");
    expect(html).toContain("Loading");
  });
});
