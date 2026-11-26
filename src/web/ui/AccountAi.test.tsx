import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { forgetSealed, setEncryptionState } from "../sealedApi.js";
import { AccountAi, ENCRYPTED_AI } from "./AccountAi.js";
import { AppContext, type AppActions } from "./appContext.js";

const render = (): string =>
  renderToStaticMarkup(
    <AppContext.Provider value={{ notify: () => undefined } as unknown as AppActions}>
      <AccountAi />
    </AppContext.Provider>,
  );

beforeEach(() => { vi.stubGlobal("window", { location: { origin: "https://vemi.test" } }); });
afterEach(() => { forgetSealed(); vi.unstubAllGlobals(); });

describe("Account > AI on an encrypted account", () => {
  it("says the connector's own line and offers nothing to connect", () => {
    for (const state of ["on", "turning_on"] as const) {
      setEncryptionState(state);
      const out = render();
      expect(out).toContain("This VEMI is fully encrypted, so AI apps can&#x27;t read it.");
      expect(ENCRYPTED_AI).toBe("This VEMI is fully encrypted, so AI apps can't read it.");
      expect(out).not.toContain("Connector address");
      expect(out).not.toContain("Connector settings");
    }
  });

  it("is as it was on a plain account", () => {
    setEncryptionState("off");
    const out = render();
    expect(out).toContain("Connector address");
    expect(out).not.toContain("fully encrypted");
  });
});
