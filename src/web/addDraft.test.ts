import { describe, expect, it } from "vitest";
import { draftKeeper } from "./addDraft.js";

describe("draftKeeper", () => {
  it("opens empty when nothing was typed", () => {
    expect(draftKeeper().open()).toBe("");
  });

  it("keeps what was typed into Add for the next time it opens", () => {
    const draft = draftKeeper();
    draft.open();
    draft.keep("Call the printer");
    expect(draft.open()).toBe("Call the printer");
  });

  it("keeps a carried title through a Cancel, as it keeps a typed one", () => {
    const draft = draftKeeper();
    expect(draft.open("Call the printer")).toBe("Call the printer");
    expect(draft.open()).toBe("Call the printer");
  });

  it("opens on a carried title over an older draft, and keeps what it opened on", () => {
    const draft = draftKeeper();
    draft.keep("Order paper");
    expect(draft.open("Call the printer")).toBe("Call the printer");
    expect(draft.open()).toBe("Call the printer");
  });

  it("keeps an edit to a carried title", () => {
    const draft = draftKeeper();
    draft.open("Call the printer");
    draft.keep("Call the printer on Monday");
    expect(draft.open()).toBe("Call the printer on Monday");
  });

  it("carries nothing for an empty title, and keeps the older draft", () => {
    const draft = draftKeeper();
    draft.keep("Order paper");
    expect(draft.open("")).toBe("Order paper");
  });

  it("forgets the draft once the task is made", () => {
    const draft = draftKeeper();
    draft.open("Call the printer");
    draft.made();
    expect(draft.open()).toBe("");
  });
});
