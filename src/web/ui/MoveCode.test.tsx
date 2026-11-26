import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { countdown } from "../moveCountdown.js";
import { MoveCode } from "./MoveCode.js";

const CODE = "ABCD-EFGH-JKMN-PQRS-TVWX";
const AT = Date.parse("2026-11-22T10:00:00.000Z");

describe("countdown", () => {
  it("counts minutes and seconds down", () => {
    expect(countdown(AT + 15 * 60_000, AT)).toBe("15:00");
    expect(countdown(AT + 14 * 60_000 + 59_000, AT)).toBe("14:59");
    expect(countdown(AT + 5_000, AT)).toBe("0:05");
  });

  it("rounds a part second up and never goes below zero", () => {
    expect(countdown(AT + 4_100, AT)).toBe("0:05");
    expect(countdown(AT, AT)).toBe("0:00");
    expect(countdown(AT - 9_000, AT)).toBe("0:00");
  });
});

describe("MoveCode", () => {
  const draw = (expiresAt: string, now: number): string =>
    renderToStaticMarkup(<MoveCode code={CODE} expiresAt={expiresAt} now={now} />);

  it("shows the code in a mono box with Copy and the time left", () => {
    const out = draw(new Date(AT + 14 * 60_000 + 59_000).toISOString(), AT);
    expect(out).toContain(`<code class="key-text move-code-text">${CODE}</code>`);
    expect(out).toContain(">Copy<");
    expect(out).toContain("14:59");
  });

  it("says Expired and takes Copy away once the time is up", () => {
    const out = draw(new Date(AT - 1_000).toISOString(), AT);
    expect(out).toContain("Expired");
    expect(out).not.toContain(">Copy<");
  });

  it("holds no instruction sentence and no em-dash", () => {
    const out = draw(new Date(AT + 60_000).toISOString(), AT);
    expect(out).not.toContain(String.fromCharCode(0x2014));
    expect(out.replace(/<[^>]*>/g, " ")).not.toMatch(/\b(enter|paste|type|use|tap|click)\b/i);
  });
});
