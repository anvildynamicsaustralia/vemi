import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { TreeVenture } from "@vemi/shared";

// EditableText reads the live resource store, which cannot be drawn on a server. Its own
// behaviour is the control's; here it shows its text. Everything else is the real control.
vi.mock("./controls.js", async (original) => ({
  ...(await original<typeof import("./controls.js")>()),
  EditableText: ({ value, placeholder }: { value: string | null; placeholder: string }) =>
    <span className="editable">{value !== null && value !== "" ? value : <span className="placeholder">{placeholder}</span>}</span>,
}));
// Pick reads the media query, which a server has none of; here it shows the kind it holds.
vi.mock("./Picker.js", () => ({
  Pick: ({ value, label }: { value: string; label: string }) => <span className="pick" data-label={label}>{value}</span>,
}));
import { monograms } from "../monogram.js";
import { AppContext, type AppActions } from "./appContext.js";
import { VentureHeader } from "./Chrome.js";
import { SpaceSettingsBody, monogramEdit, toggleView } from "./SpaceSettings.js";

const venture = (over: Partial<TreeVenture> = {}): TreeVenture =>
  ({
    id: "v1", name: "Anvil Dynamics", views: ["board", "projects"], monogram: null, projects: [],
    states: [
      { id: "s2", name: "Finished", kind: "finished", position: 1 },
      { id: "s1", name: "Waiting", kind: "not_started", position: 0 },
    ],
    stages: [{ id: "g2", name: "Live", kind: "shipped", position: 1 }, { id: "g1", name: "Building", kind: "active", position: 0 }],
    ...over,
  }) as unknown as TreeVenture;

const moveIn = () => () => undefined;

const body = (v: TreeVenture): string =>
  renderToStaticMarkup(<AppContext.Provider value={{} as AppActions}><SpaceSettingsBody venture={v} moveIn={moveIn} /></AppContext.Provider>);

describe("toggleView", () => {
  it("turns a view off while another stays on", () => {
    expect(toggleView(["board", "projects"], "projects")).toEqual(["board"]);
  });
  it("turns a view back on, in the shipped order", () => {
    expect(toggleView(["projects"], "board")).toEqual(["board", "projects"]);
  });
  it("refuses to turn the last view off", () => {
    expect(toggleView(["board"], "board")).toBeNull();
  });
});

describe("monogramEdit", () => {
  it("blank means letters from the name", () => {
    expect(monogramEdit("   ")).toBeNull();
    expect(monogramEdit("")).toBeNull();
  });
  it("keeps up to three letters, trimmed", () => {
    expect(monogramEdit(" ad ")).toBe("ad");
    expect(monogramEdit("abcd")).toBe("abc");
  });
});

describe("monograms", () => {
  it("uses a set monogram and letters from the name otherwise", () => {
    const m = monograms([{ id: "a", name: "Anvil Dynamics", monogram: "ZZ" }, { id: "b", name: "Black Dingo" }]);
    expect(m.get("a")).toBe("ZZ");
    expect(m.get("b")).toBe("BD");
  });
});

describe("SpaceSettingsBody", () => {
  it("lists the states and stages by name, in order", () => {
    const out = body(venture());
    expect(out.indexOf("Waiting")).toBeGreaterThan(-1);
    expect(out.indexOf("Waiting")).toBeLessThan(out.indexOf("Finished"));
    expect(out.indexOf("Building")).toBeLessThan(out.indexOf("Live"));
  });
  it("shows each state with its fixed kind colour", () => {
    expect(body(venture())).toContain("dot-not_started");
  });
  it("shows the monogram and both views as pressed", () => {
    const out = body(venture({ monogram: "AD" }));
    expect(out).toContain("AD");
    expect(out.match(/aria-pressed="true"/g)).toHaveLength(2);
  });
  it("shows a view that is off as not pressed", () => {
    const out = body(venture({ views: ["board"] }));
    expect(out.match(/aria-pressed="true"/g)).toHaveLength(1);
    expect(out).toContain('aria-pressed="false"');
  });
  it("no longer lives in the venture page's about section", async () => {
    const src = (await import("node:fs")).readFileSync(new URL("./VenturePage.tsx", import.meta.url), "utf8");
    expect(src).not.toContain("States, in board order");
    expect(src).not.toContain("LifecycleSection");
  });
});

describe("VentureHeader tabs", () => {
  const head = (views: readonly ("board" | "projects")[]): string =>
    renderToStaticMarkup(<VentureHeader name="Anvil" letters="A" icon={null} tab="board" onTab={() => undefined} onBack={() => undefined} views={views} />);
  it("draws both pills when both views are on", () => {
    const out = head(["board", "projects"]);
    expect(out).toContain(">Board<");
    expect(out).toContain(">Projects<");
  });
  it("a view turned off leaves the pill", () => {
    const out = head(["board"]);
    expect(out).toContain(">Board<");
    expect(out).not.toContain(">Projects<");
  });
});
