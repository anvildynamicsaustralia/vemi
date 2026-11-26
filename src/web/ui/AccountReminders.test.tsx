import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AccountReminders } from "./AccountReminders.js";
import { AppContext, type AppActions } from "./appContext.js";

describe("AccountReminders, home screen", () => {
  it("shows no Add to home screen row where the browser has no offer", () => {
    const out = renderToStaticMarkup(
      <AppContext.Provider value={{ notify: () => undefined } as unknown as AppActions}>
        <AccountReminders />
      </AppContext.Provider>,
    );
    expect(out).not.toContain("Add to home screen");
    expect(out).toContain("Morning summary");
  });
});

describe("AccountReminders in local mode", () => {
  const draw = (): string =>
    renderToStaticMarkup(
      <AppContext.Provider value={{ notify: () => undefined } as unknown as AppActions}>
        <AccountReminders local />
      </AppContext.Provider>,
    );

  it("says one line in place of the push controls and keeps the rest", () => {
    const out = draw();
    expect(out).toContain("Reminders show inside VEMI while it is open.");
    expect(out).not.toContain("Reminders are off here");
    expect(out).not.toContain("Turn on");
    expect(out).not.toContain("Send a test");
    expect(out).toContain("Morning summary");
    expect(out).toContain("Quiet hours");
    expect(out).toContain("Reminders on ");
  });

  it("has no em-dash", () => {
    expect(draw()).not.toContain(String.fromCharCode(0x2014));
  });
});
