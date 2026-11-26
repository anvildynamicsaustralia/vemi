import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Link } from "@vemi/shared";
import type { NextStep } from "../projectNext.js";
import { LinksCard, NextCard, StatsCard, siteUrl, stepWords } from "./ProjectSide.js";

const link = (role: Link["role"], url: string): Link =>
  ({ id: `l-${role}`, role, url, label: null, ventureId: "v", projectId: "p", taskId: null, createdAt: "", updatedAt: "", archivedAt: null }) as Link;

const noop = () => undefined;

describe("stepWords", () => {
  it("names a task and the milestone it is in", () => {
    const step: NextStep = { kind: "task", taskId: "t1", milestoneId: "m1" };
    const w = stepWords(step, { brief: [], tasks: [{ id: "t1", title: "Pick the name" }], milestones: [{ id: "m1", name: "Public release" }] });
    expect(w).toEqual({ title: "Pick the name", note: "Public release", go: "Done" });
  });

  it("says no milestone with the space's own word", () => {
    const step: NextStep = { kind: "task", taskId: "t1", milestoneId: null };
    const w = stepWords(step, { brief: [], tasks: [{ id: "t1", title: "X" }], milestones: [], names: { milestone: "Phase" } });
    expect(w.note).toBe("No phase");
  });

  it("points at the first empty Brief step", () => {
    const w = stepWords({ kind: "brief", step: 1 }, { brief: ["What is it", "Who it's for"], tasks: [], milestones: [] });
    expect(w.title).toBe("Fill in: Who it's for");
    expect(w.go).toBe("Write it");
  });

  it("asks for a first milestone and a first task by the space's words", () => {
    const names = { milestone: "Phase", task: "Job" };
    expect(stepWords({ kind: "milestone" }, { brief: [], tasks: [], milestones: [], names }).go).toBe("Add phase");
    expect(stepWords({ kind: "addTask", milestoneId: null }, { brief: [], tasks: [], milestones: [], names }).go).toBe("Add job");
  });
});

describe("NextCard", () => {
  it("has a Done button on a task", () => {
    const out = renderToStaticMarkup(<NextCard title="Pick the name" note="Release" go="Done" isTask onGo={noop} />);
    expect(out).toContain("Next step");
    expect(out).toContain("Pick the name");
    expect(out).toContain(">Done<");
  });

  it("has a go-to button otherwise", () => {
    const out = renderToStaticMarkup(<NextCard title="Add your first milestone" note="" go="Add milestone" isTask={false} onGo={noop} />);
    expect(out).toContain(">Add milestone<");
    expect(out).not.toContain(">Done<");
  });
});

describe("StatsCard", () => {
  it("shows left, done and milestones, marked to hide on a phone", () => {
    const out = renderToStaticMarkup(<StatsCard left={3} done={5} milestones={2} words={{ milestones: "Milestones" }} />);
    expect(out).toContain("side-stats");
    expect(out).toMatch(/<b>3<\/b><small>Left/);
    expect(out).toMatch(/<b>5<\/b><small>Done/);
    expect(out).toMatch(/<b>2<\/b><small>Milestones/);
  });
});

describe("LinksCard", () => {
  const base = { push: null, onSave: noop };

  it("offers to link a repo and a site when there are none", () => {
    const out = renderToStaticMarkup(<LinksCard repo={null} site={null} {...base} />);
    expect(out).toContain("Link a GitHub repo");
    expect(out).toContain("Link a live site");
  });

  it("shows the repo name and its last push", () => {
    const out = renderToStaticMarkup(<LinksCard repo={link("repo", "https://github.com/anvil/vemi")} site={null} {...base} push="2026-11-14T09:00:00Z" />);
    expect(out).toContain("anvil/vemi");
    expect(out).toContain('href="https://github.com/anvil/vemi"');
    expect(out).toContain("Last push 2026-11-14");
  });

  it("shows the link alone when the last push is null", () => {
    const out = renderToStaticMarkup(<LinksCard repo={link("repo", "https://github.com/anvil/vemi")} site={null} {...base} />);
    expect(out).toContain("anvil/vemi");
    expect(out).not.toContain("Last push");
  });

  it("shows the live site", () => {
    const out = renderToStaticMarkup(<LinksCard repo={null} site={link("site", "https://vemi.example.com")} {...base} />);
    expect(out).toContain('href="https://vemi.example.com"');
    expect(out).toContain("Live site");
  });
});

describe("siteUrl", () => {
  it("adds https when a scheme is missing", () => {
    expect(siteUrl("vemi.example.com")).toBe("https://vemi.example.com/");
  });
  it("keeps an http or https address", () => {
    expect(siteUrl(" http://x.test/a ")).toBe("http://x.test/a");
  });
  it("refuses other schemes and blanks", () => {
    expect(siteUrl("javascript:alert(1)")).toBeNull();
    expect(siteUrl("   ")).toBeNull();
  });
});
