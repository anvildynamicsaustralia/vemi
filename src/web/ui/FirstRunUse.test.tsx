import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { LEVEL_PRESETS } from "../levelPresets.js";
import { AppContext, type AppActions } from "./appContext.js";
import { FirstRunUse, presetWords } from "./FirstRunUse.js";

const draw = (): string =>
  renderToStaticMarkup(
    <AppContext.Provider value={{ notify: () => undefined } as unknown as AppActions}>
      <FirstRunUse />
    </AppContext.Provider>,
  );

describe("FirstRunUse", () => {
  const out = draw();

  it("shows the welcome, the question and Skip for now", () => {
    expect(out).toContain("Welcome to VEMI");
    expect(out).toContain("What are you using VEMI for?");
    expect(out).toContain("Skip for now");
  });

  it("shows each preset with its own plural words", () => {
    for (const p of LEVEL_PRESETS) {
      expect(out).toContain(`>${p.label}<`);
      expect(out).toContain(presetWords(p.names));
    }
    expect(out).toContain("Ventures, projects, milestones");
    expect(out).toContain("Subjects, assignments, checkpoints");
    expect(out).toContain("Areas, projects, goals");
    expect(out).toContain("Spaces, projects, milestones");
  });

  it("has no instruction sentence and no em-dash", () => {
    expect(out).not.toContain("This sets");
    expect(out).not.toContain("rename");
    expect(out).not.toContain(String.fromCharCode(0x2014));
  });
});
