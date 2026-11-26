import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { DEFAULT_LEVEL_NAMES, levelWords } from "../levelWords.js";
import { setLevelNames } from "../levelNames.js";
import type { Plate } from "../plates.js";
import { AppContext, type AppActions } from "./appContext.js";
import { NewSpaceSheet, Plates } from "./Plates.js";
import { Shortcuts } from "./Shortcuts.js";

/**
 * The words sweep for the space and map screens: no visible string names a level in the shipped
 * words. A person who renamed the four levels must never meet Space, Project, Milestone or Task
 * (or the code's word, venture) on these screens.
 */

const FILES = [
  "VenturePage", "Board", "Lifecycle", "Plates", "Canvas", "MapSurface", "Chrome", "NestPicker",
  "FirstVenture", "Archive", "Recent", "SelectionBar", "Palette", "Search", "Shortcuts",
];

const LEVEL_WORD = /\b(space|venture|project|milestone|task)s?\b/i;
/** The code's own kind keys: used to address the API, never shown. */
const CODE_KEY = /^(spaces?|ventures?|projects?|milestones?|tasks?)$/;

interface Found { readonly text: string; readonly line: number; readonly before: string }

/** Every string, template piece and piece of JSX text in a source, with comments left out. */
function visibleText(src: string): Found[] {
  const found: Found[] = [];
  const blank: string[] = [];
  const stack: Array<{ mode: "code" | "template"; depth: number; at: number }> = [{ mode: "code", depth: 0, at: 0 }];
  let line = 1;
  let piece = "";
  let pieceAt = 0;
  const push = (text: string, from: number, ln: number): void => {
    if (text.trim() !== "") found.push({ text, line: ln, before: src.slice(Math.max(0, from - 90), from) });
  };
  for (let i = 0; i < src.length; i++) {
    const c = src[i] as string;
    const top = stack[stack.length - 1] as { mode: "code" | "template"; depth: number; at: number };
    if (c === "\n") line++;
    if (top.mode === "template") {
      if (c === "\\") { piece += src[i + 1] ?? ""; blank.push(" ", " "); i++; continue; }
      if (c === "`") { push(piece, top.at, line); piece = ""; stack.pop(); blank.push(" "); continue; }
      if (c === "$" && src[i + 1] === "{") {
        push(piece, top.at, line);
        piece = "";
        stack.push({ mode: "code", depth: 0, at: i });
        blank.push(" ", " ");
        i++;
        continue;
      }
      piece += c;
      blank.push(c === "\n" ? "\n" : " ");
      continue;
    }
    if (c === "/" && src[i + 1] === "/") {
      while (i < src.length && src[i] !== "\n") { blank.push(" "); i++; }
      i--;
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) { blank.push(src[i] === "\n" ? "\n" : " "); if (src[i] === "\n") line++; i++; }
      blank.push(" ", " ");
      i++;
      continue;
    }
    if (c === "'" || c === "\"") {
      let j = i + 1;
      let text = "";
      while (j < src.length && src[j] !== c && src[j] !== "\n") { if (src[j] === "\\") j++; text += src[j] ?? ""; j++; }
      push(text, i, line);
      blank.push(...Array(j - i + 1).fill(" "));
      i = j;
      continue;
    }
    if (c === "`") {
      stack.push({ mode: "template", depth: 0, at: i });
      piece = "";
      pieceAt = i;
      blank.push(" ");
      continue;
    }
    if (c === "{") top.depth++;
    if (c === "}") {
      if (top.depth === 0 && stack.length > 1) { stack.pop(); blank.push(" "); continue; }
      top.depth--;
    }
    blank.push(c);
  }
  void pieceAt;
  const code = blank.join("");
  for (const m of code.matchAll(/(?<![=-])>([^<>{}=;()&|\n][^<>{}=;()&|]*)</g)) {
    const text = m[1] ?? "";
    if (/[A-Za-z]/.test(text)) {
      const ln = code.slice(0, m.index).split("\n").length;
      found.push({ text, line: ln, before: "" });
    }
  }
  return found;
}

/** What breaks the rule in a source: each hit as `line: text`. */
export function defaultWordsIn(src: string): string[] {
  const hits: string[] = [];
  for (const f of visibleText(src)) {
    if (!LEVEL_WORD.test(f.text)) continue;
    if (/(className|class|data-[a-z]+|id|key)=\{?\s*$/.test(f.before)) continue;
    if (/(from|import)\s*$/.test(f.before)) continue;
    const bare = f.text.trim();
    // Selectors, routes and keys: one run with no space and a mark between the letters.
    if (!/\s/.test(bare) && /[^A-Za-z]/.test(bare)) continue;
    // A kind key addresses the API; only a label argument is shown.
    if (f.text === bare && CODE_KEY.test(bare) && !(/^[a-z]+$/.test(bare) && !bare.endsWith("s") && /((archive|archiveAll|counted)\([^()]*|\?\?\s*)$/.test(f.before))) continue;
    hits.push(`${f.line}: ${f.text.trim()}`);
  }
  return hits;
}

describe("defaultWordsIn", () => {
  it("finds a shown word and leaves code alone", () => {
    expect(defaultWordsIn("const a = <b aria-label=\"Add a task\">Archive project</b>;")).toHaveLength(2);
    expect(defaultWordsIn("api.update(\"tasks\", id); // a task here\nconst x = { kind: \"project\" };")).toEqual([]);
    expect(defaultWordsIn("app.archive(\"tasks\", id, \"task\");")).toHaveLength(1);
    expect(defaultWordsIn("const n = found?.name ?? \"project\";")).toHaveLength(1);
    expect(defaultWordsIn("const s = `shown ${n} tasks`;")).toHaveLength(1);
    expect(defaultWordsIn("<div className={`canvas-box project${x}`} />")).toEqual([]);
  });
});

describe("space and map screens carry no default level word", () => {
  for (const name of FILES) {
    it(`${name}.tsx`, () => {
      const src = readFileSync(new URL(`./${name}.tsx`, import.meta.url), "utf8");
      expect(defaultWordsIn(src)).toEqual([]);
    });
  }
});

const NAMES = { space: "Realm", project: "Quest", milestone: "Peak", task: "Chore" };
const DEFAULTS = /\b(space|venture|project|milestone|task)s?\b/i;

const plate: Plate = {
  id: "v1", name: "Home base", icon: null, letters: "HB", stage: null, flags: [],
  counts: { left: 3, done: 1 } as Plate["counts"],
  projects: [{ id: "p1", ventureId: "v1", name: "Garden", pinned: false, flag: null, stage: null, left: 2, done: 0, onToday: true }],
  inner: [],
};

describe("with four renamed levels", () => {
  setLevelNames(NAMES);
  afterAll(() => setLevelNames(DEFAULT_LEVEL_NAMES));
  const words = levelWords(NAMES);
  // A sheet reads the focused element as it renders; a static render has no page to ask.
  beforeAll(() => {
    vi.stubGlobal("HTMLElement", class {});
    vi.stubGlobal("document", { activeElement: null });
  });
  afterAll(() => vi.unstubAllGlobals());
  const inApp = (el: ReactElement): string =>
    renderToStaticMarkup(<AppContext.Provider value={{ phone: false, today: null } as unknown as AppActions}>{el}</AppContext.Provider>);

  it("the plates and the new-plate sheet say the chosen words", () => {
    const out = inApp(<Plates plates={[plate]} words={words} onNew={() => undefined} />);
    expect(out).toContain("New realm");
    expect(out).toContain("chores left");
    expect(out.replace(/class="[^"]*"/g, "")).not.toMatch(DEFAULTS);
    const sheet = inApp(<NewSpaceSheet words={words} onAdd={async () => "sent" as const} onClose={() => undefined} />);
    expect(sheet.replace(/class="[^"]*"/g, "")).not.toMatch(DEFAULTS);
  });

  it("the shortcuts sheet says the chosen words", () => {
    const out = inApp(<Shortcuts onClose={() => undefined} />);
    expect(out).toMatch(/chore/i);
    expect(out.replace(/class="[^"]*"/g, "")).not.toMatch(DEFAULTS);
  });
});
