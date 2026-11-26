import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = (path: string): string => readFileSync(new URL(path, import.meta.url), "utf8");
const rule = (source: string, selector: string): string => {
  const at = source.indexOf(`${selector} {`);
  return at < 0 ? "" : source.slice(at, source.indexOf("}", at));
};

describe("phone layout guards", () => {
  it("the account panel's one column can shrink, so a row of two actions does not widen it past the screen", () => {
    expect(rule(css("./ui/account.css"), ".account-panel")).toContain("grid-template-columns: minmax(0, 1fr)");
  });

  it("a project's milestone tasks can shrink and break a long unbroken title", () => {
    const source = css("./ui/projectMilestones.css");
    expect(rule(source, ".pm-tasks")).toContain("minmax(0, 1fr)");
    expect(source).toMatch(/\.pm-task > :not\(\.pm-box\) \{[^}]*overflow-wrap: anywhere/);
  });

  it("Today's offers, tip and list are one column beside Needs you, not three flex children squeezed side by side", () => {
    const today = readFileSync(new URL("./ui/Today.tsx", import.meta.url), "utf8");
    const view = today.slice(today.indexOf("export function TodayView"));
    expect(view).toContain('<div className="today-col">');
    expect(css("./app.css")).toMatch(/\.today-col \{[^}]*flex: 1/);
  });

  it("a row's actions wrap rather than hold their full width", () => {
    const actions = rule(css("./app.css"), ".account-row-actions");
    expect(actions).toContain("flex-wrap: wrap");
    expect(actions).not.toContain("flex: none");
  });
});
