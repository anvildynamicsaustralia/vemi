import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

// The tree has not loaded and the read failed: what a task's sheet shows then.
vi.mock("../state/resources.js", () => ({
  useResource: () => ({ data: null, error: "Could not reach VEMI.", receivedAt: null, fromCopy: false, loading: false, unreached: true, refetch: () => undefined }),
}));

import { TaskDetail } from "./TaskDetail.js";

vi.stubGlobal("document", { activeElement: null });
vi.stubGlobal("HTMLElement", class {});

describe("TaskDetail", () => {
  it("says the read failed and offers Try again, rather than Loading for good", () => {
    const html = renderToStaticMarkup(<TaskDetail taskId="t" onClose={() => undefined} />);
    expect(html).toContain("Could not reach VEMI.");
    expect(html).toContain("Try again");
  });
});
