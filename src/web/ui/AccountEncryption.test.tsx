import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ENCRYPTION_LINES, EncryptionPanel, type EncryptionStep } from "./AccountEncryption.js";
import { PrivacySection } from "./AccountPrivacy.js";
import type { EncryptionState } from "../sealedApi.js";

const none = () => undefined;
const ways = { passkey: true, password: true, recovery: true };

function draw(state: EncryptionState, step: EncryptionStep = { at: "row" }, problem: string | null = null): string {
  return renderToStaticMarkup(
    <EncryptionPanel state={state} step={step} ways={ways} busy={false} problem={problem}
      on={{ turnOn: none, turnOff: none, carryOn: none, confirm: none, prove: none, back: none }} />,
  );
}

describe("EncryptionPanel", () => {
  it("shows Off with Turn on, and On with Turn off", () => {
    const off = draw("off");
    expect(off).toContain("Full account encryption");
    expect(off).toContain(">Off<");
    expect(off).toContain(">Turn on<");
    const on = draw("on");
    expect(on).toContain(">On<");
    expect(on).toContain(">Turn off<");
    expect(on).not.toContain(">Turn on<");
  });

  it("says the five lines before it is turned on, and no others", () => {
    const out = draw("off", { at: "explain" });
    expect(ENCRYPTION_LINES).toEqual([
      "Search runs on your devices.",
      "Reminders show titles only on your devices.",
      "The AI connector can't read this account.",
      "If you lose every device and your recovery key, nobody can get your data back.",
      "It takes a minute.",
    ]);
    const lines = [...out.matchAll(/<li>(.*?)<\/li>/g)].map((m) => (m[1] ?? "").replace(/&#x27;/g, "'"));
    expect(lines).toEqual([...ENCRYPTION_LINES]);
    expect(out).toContain(">Turn on<");
    expect(out).not.toContain("<p");
  });

  it("offers Continue from the server's state after a reload", () => {
    expect(draw("turning_on")).toContain(">Continue<");
    expect(draw("turning_on")).toContain("Turning on is not finished");
    expect(draw("turning_off")).toContain(">Continue<");
    expect(draw("turning_off")).not.toContain(">Turn off<");
  });

  it("draws a bar while it works, and a problem as an alert", () => {
    const out = draw("turning_on", { at: "working", to: "on", done: 40, total: 100 });
    expect(out).toContain('<progress class="encryption-bar" max="100" value="40"');
    expect(draw("off", { at: "row" }, "A batch stopped.")).toContain('role="alert">A batch stopped.');
  });

  it("asks one way in again to turn off, with no instruction sentence", () => {
    const out = draw("on", { at: "prove", to: "off" });
    expect(out).toContain("Face ID or fingerprint");
    expect(out).toContain("Use vault password");
    expect(out).not.toMatch(/please|enter your|click|tap/i);
  });

  it("holds no em-dash on any step", () => {
    const steps: EncryptionStep[] = [
      { at: "row" }, { at: "explain" }, { at: "prove", to: "off" }, { at: "working", to: "off", done: 1, total: 2 },
    ];
    for (const state of ["off", "on", "turning_on", "turning_off"] as const) {
      for (const step of steps) expect(draw(state, step)).not.toContain(String.fromCharCode(0x2014));
    }
  });
});

describe("PrivacySection", () => {
  it("places the encryption row after the App lock row", () => {
    const out = renderToStaticMarkup(
      <PrivacySection owner={true} appLock={<i>APPLOCK</i>} encryption={<b>FULL</b>}><p>ROWS</p></PrivacySection>,
    );
    expect(out.indexOf("ROWS")).toBeLessThan(out.indexOf("APPLOCK"));
    expect(out.indexOf("APPLOCK")).toBeLessThan(out.indexOf("FULL"));
  });
});
