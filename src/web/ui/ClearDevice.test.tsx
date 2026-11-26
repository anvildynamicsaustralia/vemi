import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ClearDevice, ClearDeviceView } from "./ClearDevice.js";

describe("ClearDeviceView", () => {
  it("offers Clear this device and nothing else before the tap", () => {
    const out = renderToStaticMarkup(<ClearDeviceView phase={{ kind: "ask" }} onClear={() => undefined} />);
    expect(out).toContain(">Clear this device<");
    expect(out).not.toContain("disabled");
  });

  it("says what it did once it has", () => {
    const said = "Cleared: the database, the saved keys and this session.";
    const out = renderToStaticMarkup(<ClearDeviceView phase={{ kind: "done", said }} onClear={() => undefined} />);
    expect(out).toContain(said);
    expect(out).not.toContain(">Clear this device<");
  });

  it("shows why nothing was cleared", () => {
    const out = renderToStaticMarkup(<ClearDeviceView phase={{ kind: "bad", reason: "Another tab holds it." }} onClear={() => undefined} />);
    expect(out).toContain("Another tab holds it.");
    expect(out).toContain(">Clear this device<");
  });

  it("holds no em-dash", () => {
    const out = renderToStaticMarkup(<ClearDeviceView phase={{ kind: "ask" }} onClear={() => undefined} />);
    expect(out).not.toContain(String.fromCharCode(0x2014));
  });
});

describe("ClearDevice", () => {
  it("does not clear on its own when it is drawn", () => {
    const wipe = vi.fn(async () => ({ ok: true as const, said: "x" }));
    renderToStaticMarkup(<ClearDevice wipe={wipe} />);
    expect(wipe).not.toHaveBeenCalled();
  });
});
