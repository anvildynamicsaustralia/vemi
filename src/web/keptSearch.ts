/**
 * Search done on this device, over the tree it holds. Pure: a `Tree`, what was typed in and,
 * for an account with full encryption, the lists the tree lacks; hits out.
 *
 * With no signal `/api/search` failed and the phone said the browser's own words for that. The
 * kept tree already holds every venture, project, milestone and task, a task's body and steps
 * with it, which is most of what anyone searches for. Notes, decisions, risks and links are
 * not in the tree, so they are found here only when `lists` is given.
 *
 * An account with full encryption is always searched here: the Worker holds only envelopes, so
 * its own search answers nothing, and the tree and the lists are read through the sealed layer,
 * which opens them. Nothing in this file sends anything.
 *
 * The Worker's own search, in the same shape (`store.ts`): a case-blind substring, kinds in
 * SEARCH_KINDS order, each kind up to its own SEARCH_MOST, and within a kind the listed text
 * that starts with the words first, then text that holds them, then the rest, A to Z.
 */
import {
  SEARCH_KINDS, SEARCH_MOST, isSealed,
  type Decision, type Link, type Note, type Risk, type SearchHit, type SearchKind, type Tree,
} from "@vemi/shared";
import { LOCKED_WORD } from "./sealedApi.js";

/**
 * The lists the tree does not hold, read once and opened.
 */
export interface DeviceLists {
  readonly notes: readonly Note[];
  readonly decisions: readonly Decision[];
  readonly risks: readonly Risk[];
  readonly links: readonly Link[];
}

/** The longest a note is listed: the archive's own cut, as the Worker lists it. */
const NOTE_LISTED = 120;

/**
 * The address a search is asked at, or null when this device does the searching. An account
 * with full encryption never sends its words anywhere.
 */
export function searchAddress(needle: string, onDevice: boolean, address: (q: string) => string): string | null {
  return needle === "" || onDevice ? null : address(needle);
}

/** A hit and the text its order is read from, which for a note is the whole body. */
interface Ranked {
  readonly hit: SearchHit;
  readonly by: string;
}

const ranked = (hit: SearchHit, by: string = hit.text): Ranked => ({ hit, by });

export function searchKept(tree: Tree, typed: string, lists?: DeviceLists): SearchHit[] {
  const needle = typed.trim().toLocaleLowerCase();
  if (needle === "") return [];
  // Text that is still an envelope, or is the word for one this device cannot open, never matches.
  const has = (text: string | null | undefined): boolean =>
    typeof text === "string" && text !== LOCKED_WORD && !isSealed(text) && text.toLocaleLowerCase().includes(needle);
  const projects = tree.ventures.flatMap((v) => v.projects);
  const tasks = tree.ventures.flatMap((v) => [...v.tasks, ...v.projects.flatMap((p) => p.tasks)]);
  const ventureOfProject = new Map(projects.map((p) => [p.id, p.ventureId]));
  const ventureOfTask = new Map(tasks.map((t) => [t.id, t.ventureId]));
  const ventures = new Set(tree.ventures.map((v) => v.id));
  /** Where a record sits: its own space, else its project's, else its task's. Not in the tree: not shown. */
  const placed = (v: string | null, p: string | null, t: string | null = null): string | null => {
    let id: string | null = v;
    if (id === null && p !== null) id = ventureOfProject.get(p) ?? null;
    if (id === null && t !== null) id = ventureOfTask.get(t) ?? null;
    return id !== null && ventures.has(id) ? id : null;
  };
  const ledger = (kind: "decision" | "risk", rows: readonly (Decision | Risk)[]): Ranked[] => rows
    .filter((r) => has(r.title) || has(r.body))
    .flatMap((r) => {
      const v = placed(r.ventureId, r.projectId);
      return v === null ? [] : [ranked({ kind, id: r.id, ventureId: v, projectId: r.projectId, taskId: null, text: r.title })];
    });
  const found: Partial<Record<SearchKind, Ranked[]>> = {
    venture: tree.ventures.filter((v) => has(v.name))
      .map((v) => ranked({ kind: "venture", id: v.id, ventureId: v.id, projectId: null, taskId: null, text: v.name })),
    // A project is found by its name or its brief, and listed and ordered by its name.
    project: projects
      .filter((p) => has(p.name) || has(p.description) || has(p.whoFor) || has(p.doneLooks) || has(p.openQuestions))
      .map((p) => ranked({ kind: "project", id: p.id, ventureId: p.ventureId, projectId: p.id, taskId: null, text: p.name })),
    milestone: projects.flatMap((p) => p.milestones.filter((m) => has(m.name))
      .map((m) => ranked({ kind: "milestone", id: m.id, ventureId: p.ventureId, projectId: p.id, taskId: null, text: m.name }))),
    task: tasks.filter((t) => has(t.title) || has(t.body) || t.checklist.some((c) => has(c.text)))
      .map((t) => ranked({ kind: "task", id: t.id, ventureId: t.ventureId, projectId: t.projectId, taskId: t.id, text: t.title })),
  };
  if (lists !== undefined) {
    found.decision = ledger("decision", lists.decisions);
    found.risk = ledger("risk", lists.risks);
    // A note is listed cut as the archive cuts it, and ordered by the whole of it.
    found.note = lists.notes.filter((n) => has(n.body)).flatMap((n) => {
      const v = placed(n.ventureId, n.projectId);
      return v === null ? [] : [ranked(
        { kind: "note", id: n.id, ventureId: v, projectId: n.projectId, taskId: null, text: n.body.slice(0, NOTE_LISTED) },
        n.body,
      )];
    });
    found.link = lists.links.filter((l) => has(l.url) || has(l.label)).flatMap((l) => {
      const v = placed(l.ventureId, l.projectId, l.taskId);
      return v === null ? [] : [ranked({ kind: "link", id: l.id, ventureId: v, projectId: l.projectId, taskId: l.taskId, text: l.label ?? l.url })];
    });
  }
  const lower = (r: Ranked): string => r.by.toLocaleLowerCase();
  const rank = (r: Ranked): number => lower(r).startsWith(needle) ? 0 : lower(r).includes(needle) ? 1 : 2;
  const by = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
  const inOrder = (a: Ranked, b: Ranked): number => rank(a) - rank(b) || by(lower(a), lower(b)) || by(a.hit.id, b.hit.id);
  return SEARCH_KINDS.flatMap((kind) => [...(found[kind] ?? [])].sort(inOrder).slice(0, SEARCH_MOST[kind]).map((r) => r.hit));
}

/** Where a search stands, as the sheet reads it from its two reads. */
export interface SearchReads {
  /** What is in the field now. */
  readonly query: string;
  /** What was last asked for, the field a moment ago. */
  readonly needle: string;
  readonly loading: boolean;
  /** The Worker answered this search. */
  readonly answered: boolean;
  readonly error: string | null;
  /** The last ask had no answer from the Worker at all. */
  readonly unreached: boolean;
  /** Hits from the kept tree, when it is being searched instead. */
  readonly kept: number | null;
  /** Hits on screen. */
  readonly hits: number;
}

export interface SearchSaid {
  /** The line above the results. */
  readonly said: string;
  /** Whether to say nothing matches. */
  readonly nothing: boolean;
  /** A failure said under results that are still shown. */
  readonly failed: string | null;
}

/** The kept tree is searched when there is no connection and no answer for this search yet. */
export function searchesKept(needle: string, answered: boolean, unreached: boolean): boolean {
  return needle !== "" && unreached && !answered;
}

/**
 * Whether what is listed answers what is in the field now. A read that failed has finished
 * too. Until then the list is the last search's, or empty, and Enter waits for the answer.
 */
export function searchSettled(r: SearchReads): boolean {
  return r.needle === r.query.trim() && !r.loading && (r.answered || r.kept !== null || r.error !== null);
}

/**
 * What the sheet says. A read that failed has finished: it is not still "Looking…", and the
 * failure is said once, in place of a count.
 */
export function searchSaid(r: SearchReads): SearchSaid {
  if (r.needle === "") return { said: "", nothing: false, failed: null };
  if (!searchSettled(r)) return { said: "Looking…", nothing: false, failed: null };
  if (r.kept !== null) {
    return { said: `No connection: searching what this device kept. ${r.hits} found`, nothing: r.hits === 0, failed: null };
  }
  // The browser's own words for a failed fetch say nothing a person can use.
  const failure = r.error === null ? null : r.unreached ? "Search needs a connection." : r.error;
  if (!r.answered) return { said: failure ?? `${r.hits} found`, nothing: false, failed: null };
  return { said: `${r.hits} found`, nothing: r.hits === 0, failed: failure };
}
