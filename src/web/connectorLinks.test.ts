import { describe, expect, it } from "vitest";
import { CHATGPT_SETTINGS, CLAUDE_SETTINGS, connectorAddress, lastUsed, onConnectorChanged, shapeGrants, tellConnectorChanged } from "./connectorLinks.js";

describe("connector links", () => {
  it("builds the address from the origin", () => {
    expect(connectorAddress("https://vemi.example.workers.dev")).toBe("https://vemi.example.workers.dev/mcp");
    expect(connectorAddress("https://vemi.example.workers.dev/")).toBe("https://vemi.example.workers.dev/mcp");
  });

  it("holds the two settings pages", () => {
    expect(CLAUDE_SETTINGS).toBe("https://claude.ai/customize/connectors");
    expect(CHATGPT_SETTINGS).toBe("https://chatgpt.com/plugins");
  });

  it("says when an app was last used", () => {
    const now = new Date("2026-11-18T12:00:00Z");
    expect(lastUsed(null, now)).toBe("not used yet");
    expect(lastUsed("2026-11-18T11:59:30Z", now)).toBe("just now");
    expect(lastUsed("2026-11-18T11:15:00Z", now)).toBe("45 min ago");
    expect(lastUsed("2026-11-18T09:00:00Z", now)).toBe("3 h ago");
    expect(lastUsed("2026-11-16T12:00:00Z", now)).toBe("2 days ago");
    expect(lastUsed("2026-11-17T09:00:00Z", now)).toBe("yesterday");
  });

  it("keeps only what a screen shows of a grant, most recent first", () => {
    const shaped = shapeGrants([
      { id: "a", clientName: "Claude", createdAt: "2026-11-01T00:00:00Z", lastUsedAt: null, tokenHash: "x" },
      { id: "b", clientName: "ChatGPT", createdAt: "2026-11-02T00:00:00Z", lastUsedAt: "2026-11-10T00:00:00Z" },
    ] as never);
    expect(shaped.map((g) => g.id)).toEqual(["b", "a"]);
    expect(Object.keys(shaped[0] ?? {}).sort()).toEqual(["clientName", "createdAt", "id", "lastUsedAt"]);
  });
});

describe("the connector-changed event", () => {
  it("reaches a listener until it stops, and a plain tree change never raises it", () => {
    const target = new EventTarget();
    let heard = 0;
    const off = onConnectorChanged(() => { heard += 1; }, target);
    target.dispatchEvent(new Event("change"));
    expect(heard).toBe(0);
    tellConnectorChanged(target);
    expect(heard).toBe(1);
    off();
    tellConnectorChanged(target);
    expect(heard).toBe(1);
  });
});
