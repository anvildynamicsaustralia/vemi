import { describe, expect, it } from "vitest";
import type { Kind } from "@vemi/shared";
import { sealedMax } from "@vemi/shared";
import { parseCreate, parsePatch } from "./validate.js";

/**
 * The limits on what a body may say, at each edge: the most a field takes is taken, one
 * more is refused with the sentence the client shows. These are what keep a stored row
 * honest, so each is pinned here rather than trusted.
 */

const ID = "00000000-0000-4000-8000-000000000001";
const OTHER = "00000000-0000-4000-8000-000000000002";

/** The least each kind needs to be made, so one field at a time can be pushed to its edge. */
const BASE: Readonly<Record<Kind, Record<string, unknown>>> = {
  ventures: { name: "Farm" },
  states: { ventureId: ID, name: "doing", kind: "underway" },
  stages: { ventureId: ID, name: "Beta", kind: "active" },
  projects: { ventureId: ID, name: "Fences" },
  milestones: { projectId: ID, name: "First paddock" },
  tasks: { ventureId: ID, title: "Mend the gate" },
  blockers: { taskId: ID, reason: "Waiting on wire" },
  notes: { ventureId: ID, body: "A note" },
  decisions: { ventureId: ID, title: "Sell the ute" },
  risks: { ventureId: ID, title: "Drought" },
  links: { taskId: ID, url: "https://example.com" },
  tags: { name: "deep work" },
};

/** Every text field with a cap: its kind, its name, the most it takes, and whether it may be blank. */
const CAPS: readonly (readonly [Kind, string, number, "required" | "optional"])[] = [
  ["ventures", "name", 120, "required"],
  ["ventures", "description", 500, "optional"],
  ["ventures", "icon", 100, "optional"],
  ["states", "name", 60, "required"],
  ["stages", "name", 60, "required"],
  ["projects", "name", 120, "required"],
  ["projects", "description", 500, "optional"],
  ["milestones", "name", 120, "required"],
  ["tasks", "title", 300, "required"],
  ["tasks", "body", 20_000, "optional"],
  ["blockers", "reason", 500, "required"],
  ["blockers", "person", 120, "optional"],
  ["notes", "body", 4000, "required"],
  ["decisions", "title", 300, "required"],
  ["decisions", "body", 20_000, "optional"],
  ["risks", "title", 300, "required"],
  ["risks", "body", 20_000, "optional"],
  ["links", "label", 200, "optional"],
  ["tags", "name", 60, "required"],
];

const errorOf = (parsed: { ok: boolean; error?: string }): string | undefined => (parsed.ok ? undefined : parsed.error);
/** What a field was read as, once a body passed. */
const fieldOf = (parsed: { ok: boolean; value?: unknown }, field: string): unknown =>
  parsed.ok ? (parsed.value as Record<string, unknown>)[field] : undefined;

describe("lockable fields", () => {
  const LOCKED: readonly (readonly [Kind, string, number])[] = [
    ["projects", "description", 500], ["projects", "whoFor", 2000], ["projects", "doneLooks", 2000],
    ["projects", "openQuestions", 2000], ["tasks", "body", 20_000], ["notes", "body", 4000],
  ];
  const envelope = (n: number): string => `v1.${"A".repeat(11)}.${"B".repeat(16)}.${"C".repeat(n)}`;

  it.each(LOCKED)("%s.%s takes an envelope up to sealedMax of its plain limit", (kind, field, max) => {
    const ok = envelope(sealedMax(max) - envelope(0).length);
    expect(ok.length).toBe(sealedMax(max));
    expect(fieldOf(parseCreate(kind, { ...BASE[kind], [field]: ok }), field)).toBe(ok);
    expect(fieldOf(parsePatch(kind, { [field]: ok }), field)).toBe(ok);
    expect(parsePatch(kind, { [field]: `${ok}C` }).ok).toBe(false);
  });

  it.each(LOCKED)("%s.%s still refuses plain text over the plain limit", (kind, field, max) => {
    expect(errorOf(parsePatch(kind, { [field]: "x".repeat(max + 1) }))).toBe(`${field} is longer than ${max} characters`);
  });
});

describe("text caps", () => {
  it.each(CAPS)("%s.%s takes %i characters and refuses one more", (kind, field, max) => {
    const at = parseCreate(kind, { ...BASE[kind], [field]: "x".repeat(max) });
    expect(at.ok).toBe(true);
    expect(fieldOf(at, field)).toBe("x".repeat(max));
    expect(errorOf(parseCreate(kind, { ...BASE[kind], [field]: "x".repeat(max + 1) }))).toBe(`${field} is longer than ${max} characters`);
  });

  it.each(CAPS)("%s.%s holds the same cap on a change", (kind, field, max) => {
    expect(parsePatch(kind, { [field]: "x".repeat(max) }).ok).toBe(true);
    expect(errorOf(parsePatch(kind, { [field]: "x".repeat(max + 1) }))).toBe(`${field} is longer than ${max} characters`);
  });

  it("measures after trimming, so the spaces round a full field do not push it over", () => {
    expect(parseCreate("tasks", { ...BASE.tasks, title: `  ${"x".repeat(300)}  ` }).ok).toBe(true);
  });

  it.each(CAPS.filter(([, , , need]) => need === "required"))("%s.%s refuses whitespace alone", (kind, field) => {
    expect(errorOf(parseCreate(kind, { ...BASE[kind], [field]: "   " }))).toBe(`${field} cannot be empty`);
  });

  it.each(CAPS.filter(([, , , need]) => need === "optional"))("%s.%s reads whitespace alone as cleared", (kind, field) => {
    const parsed = parseCreate(kind, { ...BASE[kind], [field]: " \n " });
    expect(parsed.ok).toBe(true);
    expect(fieldOf(parsed, field)).toBeNull();
  });
});

describe("a link's address", () => {
  it("takes 2048 characters and refuses one more", () => {
    const at = `https://example.com/${"a".repeat(2048 - "https://example.com/".length)}`;
    expect(at).toHaveLength(2048);
    expect(parseCreate("links", { ...BASE.links, url: at }).ok).toBe(true);
    expect(errorOf(parseCreate("links", { ...BASE.links, url: `${at}a` }))).toBe("url is longer than 2048 characters");
    expect(errorOf(parsePatch("links", { url: `${at}a` }))).toBe("url is longer than 2048 characters");
  });
});

describe("list caps", () => {
  const items = (n: number, text = "a step") => Array.from({ length: n }, () => ({ text, done: false }));

  it("takes a checklist of 200 items and refuses 201", () => {
    expect(parseCreate("tasks", { ...BASE.tasks, checklist: items(200) }).ok).toBe(true);
    expect(errorOf(parseCreate("tasks", { ...BASE.tasks, checklist: items(201) }))).toBe("checklist holds at most 200 items");
    expect(errorOf(parsePatch("tasks", { checklist: items(201) }))).toBe("checklist holds at most 200 items");
  });

  it("takes a checklist item of 500 characters and refuses 501, or a blank one", () => {
    expect(parseCreate("tasks", { ...BASE.tasks, checklist: items(1, "x".repeat(500)) }).ok).toBe(true);
    expect(errorOf(parseCreate("tasks", { ...BASE.tasks, checklist: items(1, "x".repeat(501)) }))).toBe("checklist text is longer than 500 characters");
    expect(errorOf(parseCreate("tasks", { ...BASE.tasks, checklist: items(1, "  ") }))).toBe("checklist text cannot be empty");
  });

  it("takes 50 tags and refuses 51", () => {
    const tags = (n: number) => Array.from({ length: n }, (_, i) => `tag-${i}`);
    for (const kind of ["tasks", "projects"] as const) {
      expect(parseCreate(kind, { ...BASE[kind], tagIds: tags(50) }).ok, kind).toBe(true);
      expect(errorOf(parseCreate(kind, { ...BASE[kind], tagIds: tags(51) })), kind).toBe("tagIds holds at most 50 tags");
      expect(errorOf(parsePatch(kind, { tagIds: tags(51) })), kind).toBe("tagIds holds at most 50 tags");
    }
  });
});

describe("rules across fields", () => {
  it("refuses a task that waits on itself", () => {
    expect(errorOf(parseCreate("blockers", { ...BASE.blockers, waitsOnTaskId: ID }))).toBe("a task cannot wait on itself");
    expect(parseCreate("blockers", { ...BASE.blockers, waitsOnTaskId: OTHER }).ok).toBe(true);
  });
});

describe("a note", () => {
  it("attaches to a space or a project, and to nothing else", () => {
    expect(parseCreate("notes", { body: "x", ventureId: ID }).ok).toBe(true);
    expect(parseCreate("notes", { body: "x", projectId: ID }).ok).toBe(true);
    expect(errorOf(parseCreate("notes", { body: "x", taskId: ID }))).toBe("notes has no field taskId");
    expect(errorOf(parseCreate("notes", { body: "x", milestoneId: ID }))).toBe("notes has no field milestoneId");
    expect(errorOf(parseCreate("notes", { body: "x" }))).toBe("a note attaches to exactly one of ventureId or projectId");
    expect(errorOf(parseCreate("notes", { body: "x", ventureId: ID, projectId: OTHER }))).toBe("a note attaches to exactly one of ventureId or projectId");
  });
});

describe("a change", () => {
  it("refuses an empty one, and a field it cannot change", () => {
    expect(errorOf(parsePatch("tasks", {}))).toBe("nothing to change");
    expect(errorOf(parsePatch("tasks", { dueDate: "2026-09-14" }))).toBe("tasks cannot change dueDate");
    expect(errorOf(parsePatch("notes", { taskId: ID }))).toBe("notes cannot change taskId");
  });
});
