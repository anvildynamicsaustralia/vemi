import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { TreeProject, TreeVenture } from "@vemi/shared";

// EditableText reads the live resource store, which cannot be drawn on a server. Its own
// behaviour (Enter saves, Esc cancels, blur saves) is the control's; here it shows its text.
vi.mock("./controls.js", () => ({
  EditableText: ({ value, placeholder }: { value: string | null; placeholder: string }) =>
    <span className="editable">{value !== null && value !== "" ? value : <span className="placeholder">{placeholder}</span>}</span>,
}));
import { AppContext, type AppActions } from "./appContext.js";
import { ProjectBrief } from "./ProjectBrief.js";
import { ProjectHead } from "./ProjectHead.js";

const app = {} as AppActions;

const project = (over: Partial<TreeProject> = {}): TreeProject =>
  ({
    id: "p1", ventureId: "v1", name: "Vemi Build", icon: null, description: null, whoFor: null, doneLooks: null, openQuestions: null,
    position: 0, parentId: null, stageId: null, atRisk: false, pinnedAt: null, blocked: false, tagIds: [], milestones: [], tasks: [], ...over,
  }) as unknown as TreeProject;

const venture = (projects: TreeProject[]): TreeVenture =>
  ({
    id: "v1", name: "Anvil Dynamics", projects,
    states: [{ id: "s1", name: "To do", kind: "not_started", position: 0 }, { id: "s2", name: "Done", kind: "finished", position: 1 }],
    stages: [{ id: "g2", name: "Live", kind: "shipped", position: 1 }, { id: "g1", name: "Building", kind: "active", position: 0 }],
  }) as unknown as TreeVenture;

const head = (p: TreeProject, projects: TreeProject[] = [p]): string =>
  renderToStaticMarkup(<AppContext.Provider value={app}><ProjectHead venture={venture(projects)} project={p} /></AppContext.Provider>);

const brief = (p: TreeProject): string =>
  renderToStaticMarkup(<AppContext.Provider value={app}><ProjectBrief project={p} /></AppContext.Provider>);

describe("ProjectHead", () => {
  it("draws Map, the space and the project in the breadcrumb", () => {
    const out = head(project());
    expect(out).toMatch(/>Map<.*>Anvil Dynamics<.*crumb-here">Vemi Build</s);
  });

  it("adds the parent project as one more step", () => {
    const parent = project({ id: "p0", name: "Parent Project" });
    const out = head(project({ parentId: "p0" }), [parent, project({ parentId: "p0" })]);
    expect(out).toMatch(/>Anvil Dynamics<.*>Parent Project<.*crumb-here">Vemi Build</s);
  });

  it("draws the monogram and the ring", () => {
    const out = head(project());
    expect(out).toContain(">VB<");
    expect(out).toContain('aria-label="0 left"');
  });

  it("lists No stage and the space's stages in their order, with the current one pressed", () => {
    const out = head(project({ stageId: "g1" }));
    expect(out.indexOf("No stage")).toBeLessThan(out.indexOf("Building"));
    expect(out.indexOf("Building")).toBeLessThan(out.indexOf("Live"));
    expect(out).toMatch(/aria-pressed="true"[^>]*>Building</);
    expect(out).toMatch(/aria-pressed="false"[^>]*>No stage</);
  });

  it("presses No stage when there is none, and the pin when pinned", () => {
    expect(head(project())).toMatch(/aria-pressed="true"[^>]*>No stage</);
    expect(head(project({ pinnedAt: "2026-11-01T00:00:00Z" }))).toMatch(/phead-pin" aria-pressed="true"|aria-pressed="true"[^>]*aria-label="Pin to the top of the map"/);
  });
});

describe("ProjectBrief", () => {
  it("draws four steps with their placeholders when empty, and the first one lit", () => {
    const out = brief(project());
    expect(out).toContain("0 of 4");
    for (const k of ["What is it", "Who it&#x27;s for", "What done looks like", "Open questions"]) expect(out).toContain(k);
    expect(out).toContain("One line anyone would get");
    expect(out).toContain("What&#x27;s still undecided");
    expect(out.match(/bstep cue/g)).toHaveLength(1);
    expect(out.indexOf("bstep cue")).toBeLessThan(out.indexOf("What is it"));
  });

  it("counts the written steps and lights the first empty one", () => {
    const out = brief(project({ description: "A thing", whoFor: "Me" }));
    expect(out).toContain("2 of 4");
    expect(out).toContain("A thing");
    expect(out.match(/bstep filled/g)).toHaveLength(2);
    expect(out.indexOf("bstep cue")).toBeGreaterThan(out.indexOf("Me"));
    expect(out).not.toContain("One line anyone would get");
  });

  it("lights nothing when all four are written", () => {
    const out = brief(project({ description: "a", whoFor: "b", doneLooks: "c", openQuestions: "d" }));
    expect(out).toContain("4 of 4");
    expect(out).not.toContain("bstep cue");
  });
});

describe("ProjectHead layout", () => {
  it("the header column can shrink, so the stage pills scroll instead of widening the page on a phone", async () => {
    const { readFileSync } = await import("node:fs");
    const css = readFileSync(new URL("./projectHead.css", import.meta.url), "utf8");
    const rule = /\.phead-wrap \{([^}]*)\}/.exec(css)?.[1] ?? "";
    expect(rule).toContain("grid-template-columns: minmax(0, 1fr)");
    expect(rule).toContain("min-width: 0");
  });

  it("a long name in a breadcrumb wraps the row and breaks inside the name, instead of squeezing into a sliver", async () => {
    const { readFileSync } = await import("node:fs");
    const css = readFileSync(new URL("../app.css", import.meta.url), "utf8");
    expect(/\.crumbs \{([^}]*)\}/.exec(css)?.[1]).toContain("flex-wrap: wrap");
    expect(/\.crumbs \.back-link \{([^}]*)\}/.exec(css)?.[1]).toContain("overflow-wrap: anywhere");
  });
});
