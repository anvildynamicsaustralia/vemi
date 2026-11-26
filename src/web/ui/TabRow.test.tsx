import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { TabRow, panelId, tabId } from "./TabRow.js";

const tabs = [
  { id: "a", className: "pm-card", content: <span>one</span> },
  { id: "b", className: "pm-card", content: <span>two</span> },
  { id: "", className: "pm-card", content: <span>none</span> },
];
const html = renderToStaticMarkup(<TabRow row="r" label="stages" tabs={tabs} selected="b" onPick={() => undefined} />);

describe("TabRow", () => {
  it("makes the selected tab the only stop for Tab", () => {
    expect(html).toContain(`id="${tabId("r", "b")}" type="button" role="tab" aria-selected="true" aria-controls="${panelId("r")}" tabindex="0"`);
    expect(html.match(/tabindex="-1"/g)).toHaveLength(2);
  });

  it("names the panel each tab opens, and gives the no-id tab a usable id", () => {
    expect(html.match(new RegExp(`aria-controls="${panelId("r")}"`, "g"))).toHaveLength(3);
    expect(tabId("r", "")).toBe("r-tab-none");
  });
});
