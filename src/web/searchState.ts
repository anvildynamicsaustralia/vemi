/**
 * What the Search screen holds apart from the screen: scope, the counts that go with it,
 * the searches kept on this device, and the cards that open a list of tasks. Pure; the one
 * place the device is touched is the pair of storage functions, which take the store.
 *
 * A colour never picks work here: a scope or a card says how many there are, nothing more.
 */
import {
  BUILT_IN_FILTERS, fuzzyScore,
  type DateFilters, type FilterTask, type SearchHit, type SearchKind,
} from "@vemi/shared";

export type Scope = "all" | "projects" | "tasks" | "notes";

/** The pills, in order. */
export const SCOPES: readonly Scope[] = ["all", "tasks", "projects", "notes"];

/** The order the groups are listed in: where things live, then the work, then what was written. */
const GROUPS: readonly Exclude<Scope, "all">[] = ["projects", "tasks", "notes"];

/** Which pill a kind of hit belongs to. */
export function scopeOf(kind: SearchKind): Exclude<Scope, "all"> {
  switch (kind) {
    case "venture":
    case "project":
    case "milestone":
      return "projects";
    case "task":
      return "tasks";
    default:
      return "notes";
  }
}

/** The hits a scope shows, in the order they came. */
export function scoped<T extends Pick<SearchHit, "kind">>(hits: readonly T[], scope: Scope): T[] {
  return scope === "all" ? [...hits] : hits.filter((h) => scopeOf(h.kind) === scope);
}

/** How many hits each pill would show. */
export function scopeCounts(hits: readonly Pick<SearchHit, "kind">[]): Record<Scope, number> {
  const counts: Record<Scope, number> = { all: hits.length, projects: 0, tasks: 0, notes: 0 };
  for (const h of hits) counts[scopeOf(h.kind)] += 1;
  return counts;
}

export interface HitGroup<T> {
  readonly scope: Exclude<Scope, "all">;
  readonly hits: T[];
}

/** The hits of a scope in their groups, each non-empty, with the count being `hits.length`. */
export function groupHits<T extends Pick<SearchHit, "kind">>(hits: readonly T[], scope: Scope): HitGroup<T>[] {
  const shown = scoped(hits, scope);
  return GROUPS.map((g) => ({ scope: g, hits: shown.filter((h) => scopeOf(h.kind) === g) })).filter((g) => g.hits.length > 0);
}

/** How many searches this device keeps. */
export const RECENT_SEARCHES_MOST = 5;
export const RECENT_SEARCHES_KEY = "vemi:recentSearches:v1";

/** The list with `typed` first, a repeat (case blind) moved up rather than doubled. */
export function rememberSearch(list: readonly string[], typed: string): string[] {
  const text = typed.trim();
  if (text === "") return [...list];
  const same = text.toLocaleLowerCase();
  return [text, ...list.filter((q) => q.toLocaleLowerCase() !== same)].slice(0, RECENT_SEARCHES_MOST);
}

export function readRecentSearches(store: Pick<Storage, "getItem"> = localStorage): string[] {
  try {
    const kept: unknown = JSON.parse(store.getItem(RECENT_SEARCHES_KEY) ?? "[]");
    if (!Array.isArray(kept)) return [];
    return kept.filter((q): q is string => typeof q === "string" && q.trim() !== "").slice(0, RECENT_SEARCHES_MOST);
  } catch {
    return [];
  }
}

export function writeRecentSearches(list: readonly string[], store: Pick<Storage, "setItem"> = localStorage): void {
  try {
    store.setItem(RECENT_SEARCHES_KEY, JSON.stringify(list.slice(0, RECENT_SEARCHES_MOST)));
  } catch {
    // A browser that will not keep it keeps nothing; the search itself is unharmed.
  }
}

/** A task as a card lists it: whether it is finished, and where it sits, by name. */
export type CardTask = FilterTask & { readonly where: string };

export interface OwnFilter {
  readonly id: string;
  readonly name: string;
  readonly query: string;
}

export interface FilterCard {
  readonly id: string;
  readonly name: string;
  readonly own: boolean;
  /** Null when the Worker has not said: the date cards offline show no count. */
  readonly count: number | null;
  readonly tasks: CardTask[];
}

/** The two cards that need a day, as the Worker lists them (`GET /api/filters/dates`). */
const DATE_CARDS = [
  { name: "Overdue", list: "before" },
  { name: "Due this week", list: "week" },
] as const;

/**
 * The two date cards first, from the Worker's answer (`dates`; null when there is none, and
 * those cards then show no count and no tasks), then the other built-in filters, then the
 * person's own in the order given, each with the live tasks it holds. An own filter holds the
 * tasks its words match in the title or where it sits. Nothing here compares a date.
 */
export function filterCards(tasks: readonly CardTask[], dates: DateFilters | null, own: readonly OwnFilter[]): FilterCard[] {
  const live = tasks.filter((t) => t.archivedAt === null);
  const where = new Map(tasks.map((t) => [t.id, t.where]));
  const dated = DATE_CARDS.map((c): FilterCard => {
    if (dates === null) return { id: `built:${c.name}`, name: c.name, own: false, count: null, tasks: [] };
    const held = dates[c.list].map((t): CardTask => ({ ...t, finished: false, where: where.get(t.id) ?? "" }));
    return { id: `built:${c.name}`, name: c.name, own: false, count: held.length, tasks: held };
  });
  const built = BUILT_IN_FILTERS.map((f): FilterCard => {
    const held = live.filter((t) => f.test(t));
    return { id: `built:${f.name}`, name: f.name, own: false, count: held.length, tasks: held };
  });
  const mine = own.map((f): FilterCard => {
    const held = live.filter((t) => fuzzyScore(f.query, `${t.title} ${t.where}`) !== null);
    return { id: f.id, name: f.name, own: true, count: held.length, tasks: held };
  });
  return [...dated, ...built, ...mine];
}

/** The window event the Shortcuts quick action raises; the shortcuts sheet answers it. */
export const SHORTCUTS_EVENT = "vemi:shortcuts";

/** Answers SHORTCUTS_EVENT on `target`; returns the function that stops listening. */
export function onShortcutsEvent(target: EventTarget, run: () => void): () => void {
  target.addEventListener(SHORTCUTS_EVENT, run);
  return () => target.removeEventListener(SHORTCUTS_EVENT, run);
}
