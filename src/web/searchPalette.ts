/**
 * What the search sheet lists besides the Worker's hits, and where each row goes. Pure:
 * routes in, routes out, and nothing here reads the network or the page.
 *
 * A typed word lists the hits, then the places and the one verb whose names it starts, so
 * Enter on a word opens the first thing it found. Every name here is a fixed word; nothing is
 * suggested, inferred or ranked, and nothing new is drawn: each row goes to a surface that exists.
 */
import type { SearchHit } from "@vemi/shared";
import type { Asked } from "./ledgerReach.js";
import { HOME, projectPage, surface, TABS, venture, type Route, type Tab } from "./router.js";

/** Pin a project, or take its pin off. */
export interface PinAction {
  readonly pin: string;
  readonly set: boolean;
}

/** A row that goes somewhere, or a verb: start a new task, or pin or unpin a project. */
export interface PaletteRow {
  readonly key: string;
  /** The small word before the title: what kind of thing, or where it goes. */
  readonly kind: string;
  readonly title: string;
  readonly where: string;
  readonly to: Route | "compose" | PinAction;
  /** What the page this row lands on should bring into view: its ledger, or its About. */
  readonly reach?: Asked;
}

/** What the palette needs of a project to pin it. */
export interface Pinnable {
  readonly id: string;
  readonly ventureId: string;
  readonly name: string;
  readonly pinnedAt: string | null;
}

/**
 * The pinned projects as places to go, and Pin or Unpin for every project. Pinned projects
 * come first, the longest pinned at the top; the rest keep the order they came in.
 */
export function pinRows(
  projects: readonly Pinnable[],
  spaceName: (ventureId: string) => string,
): { readonly pinned: readonly PaletteRow[]; readonly commands: readonly PaletteRow[] } {
  const pinned = projects
    .filter((p) => p.pinnedAt !== null)
    .sort((a, b) => ((a.pinnedAt ?? "") < (b.pinnedAt ?? "") ? -1 : (a.pinnedAt ?? "") > (b.pinnedAt ?? "") ? 1 : 0));
  const loose = projects.filter((p) => p.pinnedAt === null);
  return {
    pinned: pinned.map((p) => ({ key: `pinned:${p.id}`, kind: "Project", title: p.name, where: spaceName(p.ventureId), to: projectPage(p.ventureId, p.id) })),
    commands: [
      ...pinned.map((p): PaletteRow => ({ key: `unpin:${p.id}`, kind: "Pin", title: `Unpin ${p.name}`, where: spaceName(p.ventureId), to: { pin: p.id, set: false } })),
      ...loose.map((p): PaletteRow => ({ key: `pin:${p.id}`, kind: "Pin", title: `Pin ${p.name}`, where: spaceName(p.ventureId), to: { pin: p.id, set: true } })),
    ],
  };
}

const TAB_WORDS: Record<Tab, string> = { board: "Board", projects: "Projects" };

/**
 * The places, in the rail's order, then the four tabs of the venture last open when there is
 * one. Add is not a place to go here: it is the verb, `NEW_TASK`.
 */
export function places(last: { readonly id: string; readonly name: string } | null): readonly PaletteRow[] {
  const rows: PaletteRow[] = [
    { key: "go:map", kind: "Go to", title: "Map", where: "", to: HOME },
    { key: "go:today", kind: "Go to", title: "Today", where: "", to: surface("today") },
    { key: "go:review", kind: "Go to", title: "Weekly review", where: "", to: surface("review") },
    { key: "go:archive", kind: "Go to", title: "Archive", where: "", to: surface("archive") },
    { key: "go:account", kind: "Go to", title: "Account", where: "", to: surface("account") },
  ];
  if (last !== null) {
    for (const tab of TABS) rows.push({ key: `go:${tab}`, kind: "Go to", title: TAB_WORDS[tab], where: last.name, to: venture(last.id, tab) });
  }
  return rows;
}

export const NEW_TASK: PaletteRow = { key: "do:new-task", kind: "Add", title: "New task", where: "", to: "compose" };

/** The fewest letters that list a place or the verb. One letter would list half of them. */
const FEWEST = 2;

/**
 * The places and the verb whose names have a word starting with what was typed, case-blind.
 * "hor" is Horizon and "tas" is New task; "a" is nothing, so a short word does not bury the
 * hits under every place with an a in it.
 */
export function commandsFor(typed: string, rows: readonly PaletteRow[]): readonly PaletteRow[] {
  const needle = typed.trim().toLocaleLowerCase();
  if (needle.length < FEWEST) return [];
  const starts = (row: PaletteRow): boolean =>
    [row.title, row.where].some((name) => name.toLocaleLowerCase().split(/\s+/).some((word) => word.startsWith(needle)));
  return [...rows, NEW_TASK].filter(starts);
}

/**
 * Where a hit opens. A venture goes inside it; a project, or a milestone, opens the project's
 * page; a task goes to its venture's Board with its sheet open. A decision or a risk opens
 * the page whose ledger holds it, a project's or the venture's; a note or a link the task it
 * is on, else the project, else the venture's page.
 */
export function hitRoute(hit: SearchHit): Route {
  const onVenture = venture(hit.ventureId, "projects");
  switch (hit.kind) {
    case "venture": return venture(hit.id, "board");
    case "project": return projectPage(hit.ventureId, hit.id);
    case "task": return venture(hit.ventureId, "board", hit.id);
    case "milestone":
    case "decision":
    case "risk":
      return hit.projectId === null ? onVenture : projectPage(hit.ventureId, hit.projectId);
    case "note":
    case "link":
      if (hit.taskId !== null) return venture(hit.ventureId, "board", hit.taskId);
      return hit.projectId === null ? onVenture : projectPage(hit.ventureId, hit.projectId);
  }
}

/**
 * What a hit asks the page it opens to bring into view (`ledgerReach.ts`): the ledger of a
 * decision's or a risk's project or venture, and the head of the venture's About for a note
 * or a link on the venture itself, which lives there, closed unless asked for. Nothing for
 * the rest, which are on screen where they open.
 */
export function hitReach(hit: SearchHit): Asked | null {
  switch (hit.kind) {
    case "decision":
    case "risk":
      return { id: hit.projectId ?? hit.ventureId, reach: "ledger" };
    case "note":
    case "link":
      return hit.taskId === null && hit.projectId === null ? { id: hit.ventureId, reach: "about" } : null;
    default:
      return null;
  }
}
