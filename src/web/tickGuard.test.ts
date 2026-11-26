import { describe, expect, it } from "vitest";
import { DOUBLE_CLICK_MS, isStray } from "./tickGuard.js";

describe("Today's tick guard", () => {
  it("keeps its ref above TodayView's early return, so the hook count is the same on every render", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("./ui/Today.tsx", import.meta.url), "utf8");
    const view = src.slice(src.indexOf("export function TodayView"));
    expect(view.indexOf("useRef<LastTick")).toBeGreaterThan(-1);
    expect(view.indexOf("useRef<LastTick")).toBeLessThan(view.indexOf("<Pending"));
  });
});

describe("isStray", () => {
  it("lets the first tick through", () => {
    expect(isStray(null, "a", 1000)).toBe(false);
  });

  it("lets go a tick on another task that lands inside a double click", () => {
    expect(isStray({ id: "a", at: 1000 }, "b", 1000 + DOUBLE_CLICK_MS - 1)).toBe(true);
  });

  it("lets through a tick on another task a moment later, and a tick on the same task at once (an undo of it)", () => {
    expect(isStray({ id: "a", at: 1000 }, "b", 1000 + DOUBLE_CLICK_MS)).toBe(false);
    expect(isStray({ id: "a", at: 1000 }, "a", 1001)).toBe(false);
  });
});
