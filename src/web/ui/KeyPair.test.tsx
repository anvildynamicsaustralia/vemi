import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { qrMatrix } from "@vemi/shared";
import { pairLink, parsePairLink } from "../pairLink.js";
import { PairApprove, PairView, POLL_LIMIT_MS, POLL_MS, proofWays, qrFor } from "./KeyPair.js";

const nothing = (): void => undefined;
const request = { id: "q3tU9mA2xk8Wc1Zr5Bv7Yg", publicPart: "BHg2_k9d-Lm0xQp4Ra7Uv3Ts6Ny1Zc8Eo5Wi2Xb9Jf0Kd7Ph4Gu3Vt6Sr1Qn8Mo5Lc2Ib9Ha6Fz3Ey0Dx7" };

const view = (over: Partial<Parameters<typeof PairView>[0]> = {}): string =>
  renderToStaticMarkup(<PairView link="https://vemi.example/account#pair=a.b" qr="<svg></svg>" copied={false} problem={null}
    onCopy={nothing} onAgain={nothing} onBack={nothing} {...over} />);

describe("pairing link", () => {
  it("fits a QR and round trips what the new device shows", () => {
    const link = pairLink("https://vemi.example.workers.dev", request);
    expect(qrMatrix(link).length).toBeGreaterThan(20);
    expect(qrFor(link)).toContain("<svg");
    expect(parsePairLink(link)).toEqual(request);
  });

  it("gives no QR for a link too long for one, and the link stays", () => {
    expect(qrFor(`https://vemi.example/${"a".repeat(300)}`)).toBeNull();
  });

  it("polls every 2 seconds for at most 10 minutes", () => {
    expect(POLL_MS).toBe(2000);
    expect(POLL_LIMIT_MS).toBe(10 * 60 * 1000);
  });
});

describe("KeyPair view", () => {
  it("shows the QR, the link and Copy while it waits", () => {
    const out = view();
    expect(out).toContain('class="qr"');
    expect(out).toContain("https://vemi.example/account#pair=a.b");
    expect(out).toContain(">Copy<");
    expect(out).toContain("Waiting for the other device");
  });

  it("says Copied after Copy, and shows only the link when there is no QR", () => {
    expect(view({ copied: true })).toContain(">Copied<");
    expect(view({ qr: null })).not.toContain('class="qr"');
  });

  it("shows a refused key in words with a way to try again", () => {
    const out = view({ problem: "That didn't work. Try again." });
    expect(out).toContain("That didn&#x27;t work. Try again.");
    expect(out).toContain(">Try again<");
    expect(out).not.toContain("Waiting for the other device");
  });

  it("holds no em-dash", () => {
    expect(view()).not.toContain(String.fromCharCode(0x2014));
  });
});

describe("approve prompt", () => {
  const ways = proofWays({ keyRef: "r", keyCheck: "c", wraps: [] }, false);
  const draw = (asking: boolean, problem: string | null = null): string =>
    renderToStaticMarkup(<PairApprove ways={{ ...ways, password: true, recovery: true }} asking={asking} busy={false} problem={problem}
      onAllow={nothing} onNotNow={nothing} onProve={nothing} />);

  it("asks Allow or Not now first", () => {
    const out = draw(false);
    expect(out).toContain("open locked things?");
    expect(out).toContain(">Allow<");
    expect(out).toContain(">Not now<");
    expect(out).not.toContain("Use vault password");
  });

  it("asks one way in after Allow", () => {
    const out = draw(true);
    expect(out).toContain("Use vault password");
    expect(out).toContain("Use recovery key");
    expect(out).not.toContain(">Allow<");
  });

  it("shows a refusal after Allow", () => {
    expect(draw(true, "That didn't work. Try again.")).toContain("That didn&#x27;t work. Try again.");
  });
});
