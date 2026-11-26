import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { FirstRunBar } from "./FirstRunBar.js";

const draw = (props: Partial<Parameters<typeof FirstRunBar>[0]> = {}): string =>
  renderToStaticMarkup(
    <FirstRunBar step={2} homeScreen={false} phone={false} title="Name your first venture" onSkip={() => undefined} {...props} />,
  );

describe("FirstRunBar", () => {
  it("says the step, the title and Skip at a desk", () => {
    const out = draw();
    expect(out).toContain("Step 2 of 6");
    expect(out).toContain("Name your first venture");
    expect(out).toContain(">Skip<");
    expect(out).not.toContain("first-run-bar phone");
  });

  it("counts seven where the home screen step applies", () => {
    expect(draw({ homeScreen: true })).toContain("Step 2 of 7");
  });

  it("is marked for a phone", () => {
    expect(draw({ phone: true })).toContain("first-run-bar phone");
  });

  it("makes the title a button only when the person has wandered", () => {
    expect(draw()).not.toContain("first-run-title");
    expect(draw({ onOpen: () => undefined })).toContain("first-run-title");
  });

  it("carries no em-dash", () => {
    expect(draw()).not.toContain(String.fromCharCode(0x2014));
  });
});
