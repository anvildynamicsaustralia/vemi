import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Status, Switch } from "./Switch.js";

describe("Switch", () => {
  it("is a switch named for its row, with the state as aria-checked and as a word", () => {
    const on = renderToStaticMarkup(<Switch on label="Celebrations" onChange={() => undefined} />);
    expect(on).toContain('role="switch"');
    expect(on).toContain('aria-label="Celebrations"');
    expect(on).toContain('aria-checked="true"');
    expect(on).toContain(">On<");
    const off = renderToStaticMarkup(<Switch on={false} label="Celebrations" onChange={() => undefined} />);
    expect(off).toContain('aria-checked="false"');
    expect(off).toContain(">Off<");
  });

  it("cannot be used while its state is still being read", () => {
    const out = renderToStaticMarkup(<Switch on={null} label="Front page" onChange={() => undefined} />);
    expect(out).toContain("disabled");
    expect(out).toContain('aria-checked="false"');
  });
});

describe("Status", () => {
  it("draws a dot and always the word beside it", () => {
    const out = renderToStaticMarkup(<Status kind="stopped">Stopped</Status>);
    expect(out).toContain("led-stopped");
    expect(out).toContain('aria-hidden="true"');
    expect(out).toContain("Stopped");
  });
});
