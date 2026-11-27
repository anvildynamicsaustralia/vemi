/**
 * What the command palette lists, in groups. Pure: what the tree holds in, rows out, and
 * nothing here reads the network or the page.
 *
 * Every row is a place that exists or a verb that exists, built from `searchPalette.ts`
 * where its rows fit (the places, the pinned projects) and from the tree for the rest. A
 * typed text filters with `fuzzy`, a word that starts a title word ahead of one inside it.
 * When nothing matches, the one row left is a new task named by what was typed; the
 * compose sheet reads the smart dates in it.
 */
import { fuzzyFilter } from "@vemi/shared";
import type { LevelWords } from "./levelWords.js";
import { HOME, projectPage, surface, venture } from "./router.js";
import { pinRows, places, type PaletteRow, type Pinnable } from "./searchPalette.js";

/** A palette row, and the keys that reach the same place when there is one. */
export interface PaletteEntry extends PaletteRow {
  readonly hint?: string;
}

export interface PaletteSection {
  readonly name: string | null;
  readonly rows: readonly PaletteEntry[];
}

/** A task as the palette needs it: where it is and what it is called. */
export interface Findable {
  readonly id: string;
  readonly ventureId: string;
  readonly title: string;
}

export interface PaletteSource {
  readonly words: LevelWords;
  /** The space last open, if any: where a new project is made. */
  readonly last: { readonly id: string; readonly name: string } | null;
  readonly projects: readonly Pinnable[];
  readonly tasks: readonly Findable[];
  readonly spaceName: (ventureId: string) => string;
  /** The spaces, to go to by name. */
  readonly spaces?: readonly { readonly id: string; readonly name: string }[];
}

/** The most other projects an empty field lists, and the most of any group a typed word does. */
const OTHER_PROJECTS = 5;
const MOST = 8;

/** The shortcut for a row, from the shortcuts phase: the keys that reach the same place. */
const HINTS: Readonly<Record<string, string>> = {
  "do:new-task": "N",
  "do:new-project": "P",
  "do:search": "/",
  "go:map": "G M",
  "go:today": "G T",
  "go:search": "G S",
};

const hinted = (row: PaletteRow): PaletteEntry => {
  const hint = HINTS[row.key];
  return hint === undefined ? row : { ...row, hint };
};

const lower = (word: string): string => word.toLocaleLowerCase();

/** New task, New project and Weekly review. Search is under Go to, once. */
function actions(words: LevelWords, last: PaletteSource["last"]): readonly PaletteEntry[] {
  const review = places(null).find((r) => r.key === "go:review");
  const rows: readonly PaletteRow[] = [
    { key: "do:new-task", kind: "Add", title: `New ${lower(words.task)}`, where: "", to: "compose" },
    { key: "do:new-project", kind: "Add", title: `New ${lower(words.project)}`, where: last?.name ?? "", to: last === null ? HOME : venture(last.id, "projects") },
    ...(review === undefined ? [] : [{ ...review, key: "do:review", kind: "Open" }]),
  ];
  return rows.map(hinted);
}

/** Map, Today, Search, Archive and Account: the rail's places, with no space's tabs. */
function goTo(): readonly PaletteEntry[] {
  const rail = places(null).filter((r) => r.key !== "go:review");
  const search: PaletteRow = { key: "go:search", kind: "Go to", title: "Search", where: "", to: surface("search") };
  return [...rail.slice(0, 2), search, ...rail.slice(2)].map(hinted);
}

/** The projects that are not pinned, as places to go, in the order they came. */
function otherProjects(words: LevelWords, projects: readonly Pinnable[], spaceName: (id: string) => string): readonly PaletteEntry[] {
  return projects
    .filter((p) => p.pinnedAt === null)
    .map((p) => ({ key: `project:${p.id}`, kind: words.project, title: p.name, where: spaceName(p.ventureId), to: projectPage(p.ventureId, p.id) }));
}

/** A task, on its space's board with its sheet open. */
export function taskRows(words: LevelWords, tasks: readonly Findable[], spaceName: (ventureId: string) => string): readonly PaletteEntry[] {
  return tasks.map((t) => ({ key: `task:${t.id}`, kind: words.task, title: t.title, where: spaceName(t.ventureId), to: venture(t.ventureId, "board", t.id) }));
}

const section = (name: string, rows: readonly PaletteEntry[]): readonly PaletteSection[] => (rows.length === 0 ? [] : [{ name, rows }]);

/**
 * The groups, in order: Actions, Go to, Pinned, Projects, and Tasks once something is typed.
 * An empty field lists no tasks, since a list of every task is a list of nothing in
 * particular. A typed text keeps the rows it fuzzy-matches, best first. When no row matches,
 * the only row is a new task whose `where` is the typed text.
 */
export function paletteSections(typed: string, source: PaletteSource): readonly PaletteSection[] {
  const text = typed.trim();
  const { words } = source;
  const pinned = pinRows(source.projects, source.spaceName).pinned.map((row) => ({ ...row, kind: words.project }));
  const others = otherProjects(words, source.projects, source.spaceName);
  if (text === "") {
    return [
      ...section("Actions", actions(source.words, source.last)),
      ...section("Go to", goTo()),
      ...section("Pinned", pinned),
      ...section(words.projects, others.slice(0, OTHER_PROJECTS)),
    ];
  }
  const match = (rows: readonly PaletteEntry[]): readonly PaletteEntry[] => fuzzyFilter(rows, text, (r) => r.title).slice(0, MOST);
  const found = [
    ...section("Actions", match(actions(source.words, source.last))),
    ...section("Go to", match(goTo())),
    ...section(words.spaces, match((source.spaces ?? []).map((v) => ({ key: `space:${v.id}`, kind: words.space, title: v.name, where: "", to: venture(v.id) })))),
    ...section("Pinned", match(pinned)),
    ...section(words.projects, match(others)),
    ...section(words.tasks, match(taskRows(words, source.tasks, source.spaceName))),
  ];
  if (found.length > 0) return found;
  return [{ name: null, rows: [{ key: "do:new-task", kind: "Add", title: `New ${lower(source.words.task)}`, where: text, to: "compose" }] }];
}
