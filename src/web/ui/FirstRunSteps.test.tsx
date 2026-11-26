import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { AppContext, type AppActions } from "./appContext.js";
import { AddLine } from "./controls.js";
import { FirstRunBar } from "./FirstRunBar.js";
import { FirstVenture } from "./FirstVenture.js";

// Nothing has loaded: the step shows its field and waits, as it does before the tree arrives.
vi.mock("../state/resources.js", () => ({
  useResource: () => ({ data: null, error: null, loading: true, refetch: () => undefined }),
  readsBegun: () => 0,
  useReadSince: () => undefined,
}));

const app = { notify: () => undefined, act: () => Promise.resolve("sent") } as unknown as AppActions;

describe("step 2, the first space", () => {
  const out = renderToStaticMarkup(
    <AppContext.Provider value={app}>
      <FirstVenture />
    </AppContext.Provider>,
  );

  it("is one field with the suggestion as its placeholder, in the level's word", () => {
    expect(out).toContain('placeholder="Home"');
    expect(out).toContain('aria-label="Space name"');
  });

  it("has no sign out, no instruction sentence and no em-dash", () => {
    expect(out).not.toContain("Sign out");
    expect(out).not.toContain("Enter to");
    expect(out).not.toContain(String.fromCharCode(0x2014));
  });
});

describe("steps 3 and 4, the real add line", () => {
  const draw = (cue: boolean): string =>
    renderToStaticMarkup(<AddLine placeholder="a new project" onAdd={() => undefined} cue={cue} />);

  it("is marked only while it is the step's line", () => {
    expect(draw(true)).toContain("add-line first-run-cue");
    expect(draw(false)).not.toContain("first-run-cue");
  });
});

describe("step 5, the bar's one button", () => {
  const draw = (action?: { label: string; onClick: () => void }): string =>
    renderToStaticMarkup(
      <FirstRunBar step={5} homeScreen={false} phone={false} title="Put it on today" onSkip={() => undefined} action={action} />,
    );

  it("shows Put it on today as a button beside Skip", () => {
    const out = draw({ label: "Put it on today", onClick: () => undefined });
    expect(out).toContain('class="first-run-action"');
    expect(out).toContain(">Put it on today</button>");
    expect(out).toContain(">Skip<");
  });

  it("shows no button on a step that has none", () => {
    expect(draw()).not.toContain("first-run-action");
  });
});
