import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { PendingKey } from "../keyWays.js";
import { KeySetup } from "./KeySetup.js";
import { lastGroup, lastGroupMatches, RECOVERY_FILE, RecoveryKey, recoveryFileText } from "./RecoveryKey.js";

const KEY = "ABCD-EFGH-JKMN-PQRS-TVWX-YZ01-2345-6789-ABCD-EFGH-JKMN-PQRS-TVWX-YZ01";
const pending: PendingKey = { recoveryKey: KEY, save: () => Promise.reject(new Error("not here")) };
const prepare = (): Promise<PendingKey> => Promise.resolve(pending);

describe("KeySetup", () => {
  it("offers Face ID or a fingerprint first where this device can", () => {
    const out = renderToStaticMarkup(<KeySetup prepare={prepare} prf onSaved={() => undefined} />);
    expect(out).toContain("Face ID or fingerprint");
    expect(out).toContain("Vault password");
    expect(out).not.toContain("Vault password again");
  });

  it("goes straight to a vault password, typed twice, where there is no PRF", () => {
    const out = renderToStaticMarkup(<KeySetup prepare={prepare} prf={false} onSaved={() => undefined} />);
    expect(out).not.toContain(">Face ID or fingerprint<");
    expect(out).toContain('aria-label="Vault password"');
    expect(out).toContain('aria-label="Vault password again"');
    expect(out).toContain("Not your sign-in password.");
    expect(out).not.toContain(String.fromCharCode(0x2014));
  });
});

describe("RecoveryKey", () => {
  const draw = (): string =>
    renderToStaticMarkup(<RecoveryKey recoveryKey={KEY} busy={false} problem={null} onDone={() => undefined} />);

  it("shows the key once with Copy, Save as file and Print", () => {
    const out = draw();
    expect(out).toContain(KEY);
    expect(out).toContain(">Copy<");
    expect(out).toContain(">Save as file<");
    expect(out).toContain(">Print<");
  });

  it("keeps Done off until the last group is typed", () => {
    expect(draw()).toMatch(/<button[^>]*disabled[^>]*>Done</);
    expect(draw()).toContain('aria-label="Last group"');
  });

  it("holds a print view with only the key", () => {
    expect(draw()).toContain(`class="recovery-print" aria-hidden="true">${KEY}</div>`);
  });

  it("matches the last group and refuses a wrong one", () => {
    expect(lastGroup(KEY)).toBe("YZ01");
    expect(lastGroupMatches(KEY, "yz01")).toBe(true);
    expect(lastGroupMatches(KEY, " YZ-01 ")).toBe(true);
    expect(lastGroupMatches(KEY, "YZ02")).toBe(false);
    expect(lastGroupMatches(KEY, "")).toBe(false);
  });

  it("names the saved file and holds the key and the day", () => {
    expect(RECOVERY_FILE).toBe("vemi-recovery-key.txt");
    const text = recoveryFileText(KEY, "2026-11-19");
    expect(text).toContain(KEY);
    expect(text).toContain("2026-11-19");
    expect(text).not.toContain(String.fromCharCode(0x2014));
  });
});
