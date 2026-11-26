import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

// The tree has not loaded and the read failed: what Add shows then.
vi.mock("../state/resources.js", () => ({
  useResource: () => ({ data: null, error: "Could not reach VEMI.", receivedAt: null, fromCopy: false, loading: false, unreached: true, refetch: () => undefined }),
}));

import { Compose } from "./Compose.js";
import { AppContext, type AppActions } from "./appContext.js";

describe("Compose", () => {
  it("says the read failed and offers Try again, rather than an empty form with a dead Add", () => {
    const app = { today: null, phone: false, phoneMenu: [] } as unknown as AppActions;
    const html = renderToStaticMarkup(<AppContext.Provider value={app}><Compose seed={{}} onClose={() => undefined} /></AppContext.Provider>);
    expect(html).toContain("Could not reach VEMI.");
    expect(html).toContain("Try again");
  });
});
