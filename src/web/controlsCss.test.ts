import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string): string => readFileSync(new URL(path, import.meta.url), "utf8");
const bare = (text: string): string => text.replace(/\/\*[\s\S]*?\*\//g, "");
const controls = bare(read("./ui/controls.css"));
const main = read("./main.tsx");

describe("the shared control layer", () => {
  it("is imported by the app, after the stylesheet it overrides", () => {
    expect(main).toContain('import "./ui/controls.css"');
    expect(main.indexOf('import "./app.css"')).toBeLessThan(main.indexOf('import "./ui/controls.css"'));
  });

  it("names no colour of its own and no raw duration", () => {
    expect(controls).not.toMatch(/#[0-9a-fA-F]{3,6}\b|\brgba?\(\s*\d/);
    const raw = controls.split("\n").filter((line) => /(transition|animation)[^;]*[^\w-][\d.]+m?s\b/.test(line));
    expect(raw).toEqual([]);
  });

  it("draws a 2px ring on every field, and never takes the outline away", () => {
    expect(controls).toMatch(/:is\(input, textarea, select[^)]*\):focus-visible \{\s*outline: 2px solid var\(--vemi-live\)/);
    expect(controls).not.toMatch(/outline:\s*(0|none)/);
  });

  it("brings a control's border to the line token, which the theme holds at 3:1", () => {
    expect(controls).toMatch(/\.chip[^{]*\{\s*border-color: var\(--vemi-line\)/);
    expect(controls).toMatch(/\.field[^{]*\{\s*border-color: var\(--vemi-line\)/);
  });

  it("sizes targets at 44px for touch and 32px for a mouse", () => {
    const coarse = controls.slice(controls.indexOf("@media (pointer: coarse)"));
    expect(coarse).toContain("min-height: var(--touch)");
    expect(coarse).toContain(".switch");
    const fine = controls.slice(controls.indexOf("@media (pointer: fine)"), controls.indexOf("@media (pointer: coarse)"));
    expect(fine).toContain("min-height: var(--target-fine)");
    expect(controls).toContain("--target-fine: 32px");
  });

  it("clears the notch for the bars fixed to an edge", () => {
    for (const rule of [".deletion-bar", ".reminder-banner", ".selection-bar"]) {
      const at = controls.indexOf(`:root ${rule}`);
      expect(at).toBeGreaterThan(-1);
      expect(controls.slice(at, controls.indexOf("}", at))).toContain("env(safe-area-inset-");
    }
  });

  it("uses no motion of its own beyond the named tokens, which reduced motion takes to zero", () => {
    expect(controls).not.toContain("@keyframes");
    expect(controls).toContain("var(--m-quick)");
    expect(bare(read("./app.css"))).toMatch(/prefers-reduced-motion: reduce[\s\S]*--m-quick: 0ms/);
  });

  it("gives a status dot its word, and a project on today the word Today", () => {
    expect(controls).toContain('content: "Today"');
    expect(controls).toContain(".led-stopped");
  });

  it("aligns text typed right to left by its own start", () => {
    expect(controls).toMatch(/\[dir="auto"\] \{ text-align: start; \}/);
  });

  it("puts Today's offer card flush with the column", () => {
    expect(controls).toMatch(/\.today-col > \.first-run-card \{ margin: 0 0/);
  });
});

describe("user-typed text takes its own direction", () => {
  const has = (file: string, ...needles: string[]): void => {
    const text = read(file);
    for (const needle of needles) expect(text, `${file}: ${needle}`).toContain(needle);
  };

  it("on titles and notes the app draws from what a person typed", () => {
    has("./ui/controls.tsx", '<button ref={reading} type="button" dir="auto"', '<textarea dir="auto"', '<input dir="auto"', '<input ref={field} dir="auto"');
    has("./ui/TodayRow.tsx", 'dir="auto" className="trow-title"');
    has("./ui/Board.tsx", 'dir="auto" className="card-open task-title"');
    has("./ui/Compose.tsx", 'className="big-field" dir="auto"');
    has("./ui/MarkdownBlocks.tsx", '<p key={i} dir="auto"', '<li key={j} dir="auto"');
    has("./ui/ProjectNotes.tsx", 'dir="auto" className="editable notes-text"', '<textarea dir="auto" className="editing notes-text"');
  });
});

describe("the choices that were pairs of On and Off", () => {
  it("are real switches", () => {
    for (const file of ["./ui/AccountAbout.tsx", "./ui/AccountExtras.tsx", "./ui/AccountReminders.tsx", "./ui/FirstRunRemind.tsx"]) {
      const text = read(file);
      expect(text, file).toContain("<Switch ");
      expect(text, file).not.toMatch(/>On<\/Chip>|>Off<\/Chip>/);
    }
  });
});
