import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { UPDATE_DOCS } from "../../shared/releaseKey.js";
import type { UpdateReport } from "../updateApi.js";
import type { RunState } from "../updateRun.js";
import { UpdateView } from "./UpdateRow.js";

const offer = (canUpdate: boolean, notes = "Faster search."): UpdateReport => ({ current: "0.1.0", offer: { version: "0.2.0", notes }, canUpdate });

const draw = (report: UpdateReport | null, run: RunState | null = null): string =>
  renderToStaticMarkup(<UpdateView report={report} run={run} onUpdate={() => undefined} onRetry={() => undefined} />);

describe("UpdateView", () => {
  it("shows nothing with no offer", () => {
    expect(draw(null)).toBe("");
    expect(draw({ current: "0.1.0", offer: null, canUpdate: true })).toBe("");
  });

  it("offers the owner with a key an Update button and the notes", () => {
    const out = draw(offer(true));
    expect(out).toContain("Update available: 0.2.0");
    expect(out).toContain("Faster search.");
    expect(out).toContain(">Update<");
    expect(out).not.toContain(UPDATE_DOCS);
  });

  it("gives everyone else the row and a link to the docs", () => {
    const out = draw(offer(false));
    expect(out).toContain("Update available");
    expect(out).not.toContain(">Update<");
    expect(out).toContain(`href="${UPDATE_DOCS}"`);
  });

  it("draws notes as text, never as markup", () => {
    const out = draw(offer(true, "<img src=x onerror=alert(1)>"));
    expect(out).not.toContain("<img");
    expect(out).toContain("&lt;img");
  });

  it("lists the steps in plain words while it runs", () => {
    const out = draw(offer(true), { at: "data", done: false, error: null });
    for (const word of ["Restore point", "App files", "Data layout", "New version"]) expect(out).toContain(word);
    expect(out).toContain("Done");
    expect(out).toContain("Working");
    expect(out).toContain("Waiting");
    expect(out).not.toContain(">Update<");
  });

  it("stops the list with the Worker's sentence and a Try again row", () => {
    const out = draw(offer(true), { at: "files", done: false, error: "Cloudflare did not answer." });
    expect(out).toContain("Cloudflare did not answer.");
    expect(out).toContain("Try again");
    expect(out).toContain('data-state="failed"');
  });

  it("reads Updated to the version at the end", () => {
    const out = draw(offer(true), { at: "app", done: true, error: null });
    expect(out).toContain("Updated to 0.2.0");
    expect(out).not.toContain("Update available");
  });

  it("has no em-dash", () => {
    expect(draw(offer(true), { at: "files", done: false, error: "No." })).not.toContain(String.fromCharCode(0x2014));
  });
});
