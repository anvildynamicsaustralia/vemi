import { markTipSeen } from "../firstRunState.js";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import {
  highlight, type DateFilters, type Decision, type Link, type Note, type Risk, type SearchHit, type SearchKind, type Tree,
} from "@vemi/shared";
import { encryptionState } from "../sealedApi.js";
import {
  lockedFields, paths, removeSavedFilter, renameSavedFilter, saveFilter, type FiltersAnswer, type SearchAnswer,
} from "../api.js";
import { searchAddress, searchesKept, searchKept, searchSaid, searchSettled, type SearchReads } from "../keptSearch.js";
import { findInArchive } from "../archiveFind.js";
import { ask } from "../ledgerReach.js";
import { isLockedHit, lockedSearch, mergeLocked, type LockedHit } from "../lockedSearch.js";
import { useLevelWords } from "../levelNames.js";
import { navigate, surface, venture } from "../router.js";
import { commandsFor, hitReach, hitRoute, pinRows, places, type PaletteRow } from "../searchPalette.js";
import {
  SCOPES, SHORTCUTS_EVENT, filterCards, groupHits, readRecentSearches, rememberSearch, scopeCounts, scoped,
  writeRecentSearches, type CardTask, type FilterCard, type Scope,
} from "../searchState.js";
import { useResource } from "../state/resources.js";
import { indexTree, kindOf } from "../treeIndex.js";
import { lastVenture, useApp } from "./appContext.js";
import { SurfaceKicker } from "./Chrome.js";
import { Chip } from "./Chip.js";
import { MoreMenu } from "./Menu.js";
import { Tip } from "./Tip.js";
import { useVault } from "./vaultContext.js";
import "./searchScreen.css";

const SEARCH_DEBOUNCE_MS = 140;

/** The longest name and the longest search a saved filter holds, as the Worker takes them. */
const NAME_MOST = 60;
const QUERY_MOST = 200;

/** The matched words of a text, marked. */
function Marked({ text, typed }: { readonly text: string; readonly typed: string }) {
  return (
    <>
      {highlight(text, typed).map((part, i) => (part.match ? <mark key={i} className="search-mark">{part.text}</mark> : <span key={i}>{part.text}</span>))}
    </>
  );
}

/** One thing the arrow keys can rest on, and what Enter does to it. */
interface Entry {
  readonly key: string;
  readonly run: () => void;
}

/**
 * Search, on `/`: one field, scope pills, and everything found in groups with their counts and
 * the matched words marked. Each hit goes where it lives (`hitRoute`): a note or a link to the
 * task or project it is on, or to its venture's About, opened. With nothing typed it shows the
 * filter cards with live counts (the built-in ones, then the person's own), the last five
 * searches on this device, and the quick actions. A card lists its tasks in place. Offline, the
 * kept tree is searched, as before (`keptSearch.ts`). Enter still opens the first hit.
 */
export function SearchSheet({ onClose }: { readonly onClose: () => void }) {
  const app = useApp();
  const words = useLevelWords();
  const [query, setQuery] = useState("");
  const [needle, setNeedle] = useState("");
  const [selected, setSelected] = useState(0);
  const [scope, setScope] = useState<Scope>("all");
  const [openCard, setOpenCard] = useState<string | null>(null);
  const [recents, setRecents] = useState<readonly string[]>(() => readRecentSearches());
  const [naming, setNaming] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<{ readonly id: string; readonly name: string } | null>(null);
  // Enter pressed before the answer for what is typed waits for that answer, not the last one.
  const waiting = useRef(false);

  useEffect(() => {
    const timer = window.setTimeout(() => setNeedle(query.trim()), SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [query]);
  useEffect(() => setSelected(0), [needle, openCard]);

  // An account with full encryption is searched here, over what the sealed layer opens: the
  // Worker holds only envelopes, so no search is ever asked of it.
  const onDevice = encryptionState() !== "off";
  const found = useResource<SearchAnswer>(searchAddress(needle, onDevice, paths.search));
  const tree = useResource<Tree>(paths.tree);
  const listed = (kind: "notes" | "decisions" | "risks" | "links"): string | null =>
    onDevice && needle !== "" ? paths.list(kind) : null;
  const notes = useResource<Note[]>(listed("notes"));
  const decisions = useResource<Decision[]>(listed("decisions"));
  const risks = useResource<Risk[]>(listed("risks"));
  const links = useResource<Link[]>(listed("links"));
  const deviceHits = useMemo(
    () => (onDevice && needle !== "" && tree.data !== null && notes.data !== null && decisions.data !== null
      && risks.data !== null && links.data !== null
      ? searchKept(tree.data, needle, { notes: notes.data, decisions: decisions.data, risks: risks.data, links: links.data })
      : null),
    [onDevice, needle, tree.data, notes.data, decisions.data, risks.data, links.data],
  );
  const reading = [tree, notes, decisions, risks, links];
  const deviceError = reading.find((r) => r.error !== null)?.error ?? null;
  const saved = useResource<FiltersAnswer>(paths.filters);
  const dateLists = useResource<DateFilters>(paths.dateFilters);
  const index = useMemo(() => (tree.data === null ? null : indexTree(tree.data)), [tree.data]);
  // No connection and no answer for this search yet: the tree this device kept is searched
  // instead, and the sheet says so.
  const offline = !onDevice && searchesKept(needle, found.data !== null, found.unreached);
  const kept = useMemo(
    () => (offline && tree.data !== null ? searchKept(tree.data, needle) : null),
    [offline, tree.data, needle],
  );
  // Locked content is opened and matched here, only while this device holds the key; with it
  // closed nothing is asked of the Worker and nothing about locked items is said.
  const vault = useVault();
  const vaultRef = useRef(vault);
  vaultRef.current = vault;
  const indexRef = useRef(index);
  indexRef.current = index;
  const [lockedHits, setLockedHits] = useState<readonly LockedHit[]>([]);
  useEffect(() => {
    let current = true;
    if (needle === "" || vault.state !== "open") {
      setLockedHits([]);
      return () => { current = false; };
    }
    void (async () => {
      try {
        const fields = await lockedFields();
        const nameOf = (kind: "project" | "task", id: string): string | undefined => {
          if (kind === "task") return indexRef.current?.tasks.get(id)?.task.title;
          const at = fields.find((f) => f.kind === "projects" && f.id === id);
          return indexRef.current?.ventures.get(at?.ventureId ?? "")?.projects.find((p) => p.id === id)?.name;
        };
        const found = await lockedSearch(needle, fields, vaultRef.current, nameOf);
        if (current) setLockedHits(found);
      } catch {
        if (current) setLockedHits([]);
      }
    })();
    return () => { current = false; };
  }, [needle, vault.state]);
  const plainHits = needle === "" ? [] : onDevice ? deviceHits ?? [] : kept ?? found.data?.results ?? [];
  const hits: readonly SearchHit[] = needle === "" ? [] : mergeLocked(plainHits, lockedHits);

  const kindWords: Record<SearchKind, string> = {
    venture: words.space, project: words.project, milestone: words.milestone, task: words.task,
    decision: "Decision", risk: "Risk", note: "Note", link: "Link",
  };
  const scopeWords: Record<Exclude<Scope, "all">, string> = { projects: words.projects, tasks: words.tasks, notes: "Notes" };

  /**
   * Where a hit lives: a task's project, or the venture it is in; anything else's task or
   * project, by name. Nothing for a venture.
   */
  const whereOf = (hit: SearchHit): string => {
    const ventureName = index?.ventures.get(hit.ventureId)?.name ?? "";
    if (hit.kind === "venture") return "";
    if (hit.kind === "task") return index?.tasks.get(hit.id)?.project?.name ?? ventureName;
    if (hit.taskId !== null) return index?.tasks.get(hit.taskId)?.task.title ?? ventureName;
    if (hit.projectId !== null) return index?.ventures.get(hit.ventureId)?.projects.find((p) => p.id === hit.projectId)?.name ?? ventureName;
    return ventureName;
  };

  const last = useMemo(() => {
    const id = lastVenture();
    const known = id === null ? undefined : index?.ventures.get(id);
    return known === undefined ? null : { id: known.id, name: known.name };
  }, [index]);
  const goTo = useMemo(() => places(last), [last]);
  const pins = useMemo(
    () => pinRows(
      tree.data === null ? [] : tree.data.ventures.flatMap((v) => v.projects),
      (id) => index?.ventures.get(id)?.name ?? "",
    ),
    [tree.data, index],
  );

  // The hits of the chosen pill, then the places and the verb a typed word reaches, in the
  // order the arrow keys move through them.
  const hitRows = scoped(hits, scope).map((hit): PaletteRow & { readonly hit: SearchHit; readonly locked: boolean } => {
    const reach = hitReach(hit);
    return { key: `${hit.kind}:${hit.id}`, kind: kindWords[hit.kind], title: hit.text, where: whereOf(hit), to: hitRoute(hit), hit, locked: isLockedHit(hit), ...(reach === null ? {} : { reach }) };
  });
  const commandRows = needle === "" ? [] : commandsFor(needle, [...goTo, ...pins.commands]);
  const rows: readonly PaletteRow[] = [...hitRows, ...commandRows];
  const counts = scopeCounts(hits);

  const keep = (): void => {
    const next = rememberSearch(recents, query);
    setRecents(next);
    writeRecentSearches(next);
  };

  const open = (row: PaletteRow): void => {
    if (row.to === "compose") {
      app.compose(query.trim() === "" ? {} : { title: query.trim() });
      return;
    }
    if (typeof row.to === "object" && "pin" in row.to) {
      const { pin: id, set } = row.to;
      const name = tree.data?.ventures.flatMap((v) => v.projects).find((p) => p.id === id)?.name ?? words.project.toLowerCase();
      const was = tree.data?.ventures.flatMap((v) => v.projects).find((p) => p.id === id)?.pinnedAt ?? null;
      const now = set ? new Date().toISOString() : null;
      void app.edit("projects", id, { pinnedAt: now }, { pinnedAt: was }, `${set ? "pinned" : "unpinned"} ${name}`);
      onClose();
      return;
    }
    // A search that found what was wanted is the one worth keeping.
    if (needle !== "") keep();
    // A decision or a risk: the page it opens brings its ledger into view. A note or a link
    // on a venture: the venture's About, opened.
    if (row.reach !== undefined) ask(row.reach.id, row.reach.reach);
    navigate(row.to);
  };

  // The filter cards, from the tree this device holds. The two date cards take the Worker's
  // lists; with no answer from it (no connection, or only a copy) they show no count.
  const dates = dateLists.data !== null && !dateLists.unreached && !dateLists.fromCopy ? dateLists.data : null;
  const cards = useMemo((): FilterCard[] | null => {
    if (index === null) return null;
    const all: CardTask[] = [...index.tasks.values()].map(({ task, venture: v, project }) => ({
      ...task, finished: kindOf(task, v) === "finished", where: project?.name ?? v.name,
    }));
    return filterCards(all, dates, saved.data?.filters ?? []);
  }, [index, dates, saved.data]);
  const card = cards?.find((c) => c.id === openCard) ?? null;

  const newProjectIn = last?.id ?? index?.top[0]?.id ?? null;
  const quick: readonly { readonly key: string; readonly label: string; readonly run: () => void }[] = [
    { key: "q:task", label: `New ${words.task.toLowerCase()}`, run: () => app.compose() },
    ...(newProjectIn === null ? [] : [{ key: "q:project", label: `New ${words.project.toLowerCase()}`, run: () => navigate(venture(newProjectIn, "projects")) }]),
    { key: "q:review", label: "Weekly review", run: () => navigate(surface("review")) },
    ...(app.phone ? [] : [{ key: "q:shortcuts", label: "Shortcuts", run: () => { window.dispatchEvent(new Event(SHORTCUTS_EVENT)); } }]),
  ];

  const runSearch = (text: string): void => {
    waiting.current = false;
    setOpenCard(null);
    setQuery(text);
    setNeedle(text.trim());
  };

  const openTask = (t: CardTask): void => navigate(venture(t.ventureId, "board", t.id));

  // What the arrow keys rest on, as one list for whichever screen is showing.
  const entries: readonly Entry[] = card !== null
    ? card.tasks.map((t) => ({ key: `task:${t.id}`, run: () => openTask(t) }))
    : query.trim() === "" && cards !== null
      ? [
        ...cards.map((c) => ({ key: `card:${c.id}`, run: () => setOpenCard(c.id) })),
        { key: "card:archive", run: () => navigate(surface("archive")) },
        ...recents.map((r) => ({ key: `recent:${r}`, run: () => runSearch(r) })),
        ...quick.map((q) => ({ key: q.key, run: q.run })),
      ]
      : rows.map((row) => ({ key: row.key, run: () => open(row) }));

  // On the device the answer is the lists and the tree read, not a search: it is given once all
  // five are here, and never says it is searching what the device kept.
  const reads: SearchReads = onDevice
    ? {
      query, needle, loading: needle !== "" && deviceHits === null && deviceError === null,
      answered: deviceHits !== null, error: deviceHits === null ? deviceError : null,
      unreached: reading.some((r) => r.unreached), kept: null, hits: hits.length,
    }
    : {
      query, needle, loading: found.loading, answered: found.data !== null, error: found.error,
      unreached: found.unreached, kept: kept === null ? null : kept.length, hits: hits.length,
    };
  const settled = searchSettled(reads);
  const { said, nothing, failed } = searchSaid(reads);

  /** Enter, on the answer for the field as it is: the row chosen, or a task named by what matched nothing. */
  const enter = (at: number): void => {
    const row = rows[at];
    if (row !== undefined) open(row);
    else if (nothing) app.compose({ title: query.trim() });
  };

  // An Enter that waited is answered the moment the search is, on the first hit.
  useEffect(() => {
    if (!waiting.current || !settled) return;
    waiting.current = false;
    enter(0);
  });

  const onKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>): void => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelected(Math.max(0, Math.min(entries.length - 1, selected + 1)));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelected(Math.max(0, selected - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (query.trim() === "") {
        // An empty field lists cards, searches and actions, which need no search to wait for.
        entries[selected]?.run();
        return;
      }
      if (settled) {
        enter(selected);
        return;
      }
      // The rest of the pause is not sat out: the search is asked now, and Enter acts on it.
      waiting.current = true;
      setNeedle(query.trim());
    } else if (e.key === "Escape" && (query !== "" || openCard !== null)) {
      // Clears the field first, then the open card; the next Escape leaves.
      e.stopPropagation();
      waiting.current = false;
      if (query !== "") setQuery("");
      else setOpenCard(null);
    }
  };

  const saveAs = (name: string): void => {
    const label = name.trim();
    if (label === "") return;
    setNaming(null);
    void app.act(() => saveFilter(label, query.trim())).then((outcome) => {
      if (outcome !== false) { saved.refetch(); markTipSeen("search"); }
    });
  };

  const rename = (): void => {
    if (renaming === null) return;
    const { id, name } = renaming;
    setRenaming(null);
    if (name.trim() === "") return;
    void app.act(() => renameSavedFilter(id, name.trim())).then((outcome) => {
      if (outcome !== false) saved.refetch();
    });
  };

  const remove = (c: FilterCard): void => {
    if (openCard === c.id) setOpenCard(null);
    void app.act(() => removeSavedFilter(c.id)).then((outcome) => {
      if (outcome !== false) saved.refetch();
    });
  };

  const typed = query.trim() !== "";
  const canSave = typed && settled && hits.length > 0 && needle.length <= QUERY_MOST
    && !(saved.data?.filters ?? []).some((f) => f.query === needle);
  const rest = (i: number): string => (i === selected ? " on" : "");
  let at = -1;
  const next = (): number => (at += 1);

  return (
    <div className="search">
      <SurfaceKicker menu={<MoreMenu label="search" items={app.phoneMenu} />}>Search</SurfaceKicker>
      <Tip name="search" />
      <input className="big-field search-input" autoFocus value={query} placeholder="Search" aria-label="search"
        onChange={(e) => { waiting.current = false; setOpenCard(null); setQuery(e.target.value); }} onKeyDown={onKeyDown} />
      <div className="search-scopes seg" role="group" aria-label="scope">
        {SCOPES.map((s) => (
          <Chip key={s} on={scope === s} aria-pressed={scope === s} onClick={() => { setScope(s); setSelected(0); }}>
            {s === "all" ? "All" : scopeWords[s]}
            {typed && hits.length > 0 && <span className="search-count">{counts[s]}</span>}
          </Chip>
        ))}
      </div>
      <div className="search-said" role="status">{card === null ? said : ""}</div>

      {card !== null && (
        <div className="results">
          <div className="results-group" role="group" aria-label={card.name}>
            <div className="kicker results-kicker search-card-head">
              <span>{card.count === null ? card.name : `${card.name} · ${card.count}`}</span>
              <button type="button" className="word-button" onClick={() => setOpenCard(null)}>Clear</button>
            </div>
            {card.tasks.length === 0 && <div className="rows-empty">Nothing here.</div>}
            {card.tasks.map((t) => {
              const i = next();
              return (
                <button key={t.id} type="button" className={`result${rest(i)}`} onMouseEnter={() => setSelected(i)} onClick={() => openTask(t)}>
                  <span className="result-kind">{words.task}</span>
                  <span className="result-title">{t.title}</span>
                  <span className="result-where">{t.where}</span>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {card === null && !typed && (
        <div className="results">
          {cards === null ? (
            tree.error !== null && <div className="rows-empty">{tree.error}</div>
          ) : (
            <div className="results-group" role="group" aria-label="filters">
              <div className="kicker results-kicker">Filters</div>
              <div className="search-cards">
                {cards.map((c) => {
                  const i = next();
                  return (
                    <div key={c.id} className={`search-card${rest(i)}`}>
                      {renaming?.id === c.id ? (
                        <input className="search-card-name" autoFocus aria-label="filter name" maxLength={NAME_MOST} value={renaming.name}
                          onChange={(e) => setRenaming({ id: c.id, name: e.target.value })} onBlur={rename}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") { e.preventDefault(); rename(); }
                            else if (e.key === "Escape") { e.stopPropagation(); setRenaming(null); }
                          }} />
                      ) : (
                        <button type="button" className="search-card-open" onMouseEnter={() => setSelected(i)} onClick={() => setOpenCard(c.id)}>
                          {c.count !== null && <b>{c.count}</b>}
                          <span>{c.name}</span>
                        </button>
                      )}
                      {c.own && renaming?.id !== c.id && (
                        <MoreMenu className="search-card-more" label={`filter ${c.name}`} items={[
                          { label: "Rename", run: () => setRenaming({ id: c.id, name: c.name }) },
                          { label: "Remove", tone: "remove", run: () => remove(c) },
                        ]} />
                      )}
                    </div>
                  );
                })}
                {(() => {
                  const i = next();
                  return (
                    <div className={`search-card${rest(i)}`}>
                      <button type="button" className="search-card-open" onMouseEnter={() => setSelected(i)} onClick={() => navigate(surface("archive"))}>
                        <span>Archive</span>
                      </button>
                    </div>
                  );
                })()}
              </div>
            </div>
          )}
          {recents.length > 0 && (
            <div className="results-group" role="group" aria-label="recent searches">
              <div className="kicker results-kicker">Recent searches</div>
              <div className="search-pills">
                {recents.map((r) => {
                  const i = next();
                  return <Chip key={r} className={rest(i).trim()} onMouseEnter={() => setSelected(i)} onClick={() => runSearch(r)}>{r}</Chip>;
                })}
              </div>
            </div>
          )}
          <div className="results-group" role="group" aria-label="quick actions">
            <div className="kicker results-kicker">Quick actions</div>
            <div className="search-pills">
              {quick.map((q) => {
                const i = next();
                return <Chip key={q.key} className={rest(i).trim()} onMouseEnter={() => setSelected(i)} onClick={q.run}>{q.label}</Chip>;
              })}
            </div>
          </div>
        </div>
      )}

      {card === null && typed && (
        <div className="results">
          {groupHits(hitRows.map((row) => ({ kind: row.hit.kind, row })), "all").map((group) => (
            <div key={group.scope} className="results-group" role="group" aria-label={scopeWords[group.scope]}>
              <div className="kicker results-kicker">{scopeWords[group.scope]} · {group.hits.length}</div>
              {group.hits.map(({ row }) => {
                const i = next();
                return (
                  <button key={row.key} type="button" className={`result${rest(i)}`} onMouseEnter={() => setSelected(i)} onClick={() => open(row)}>
                    <span className="result-kind">{row.kind}{row.locked ? " (locked)" : ""}</span>
                    <span className="result-title"><Marked text={row.title} typed={needle} /></span>
                    <span className="result-where">{row.where}</span>
                  </button>
                );
              })}
            </div>
          ))}
          {commandRows.length > 0 && (
            <div className="results-group">
              {commandRows.map((row) => {
                const i = next();
                return (
                  <button key={row.key} type="button" className={`result${rest(i)}`} onMouseEnter={() => setSelected(i)} onClick={() => open(row)}>
                    <span className="result-kind">{row.kind}</span>
                    <span className="result-title">{row.title}</span>
                    <span className="result-where">{row.where}</span>
                  </button>
                );
              })}
            </div>
          )}
          {canSave && (naming === null
            ? <button type="button" className="word-button search-save" onClick={() => setNaming(needle.slice(0, NAME_MOST))}>Save as a filter</button>
            : (
              <input className="search-save-name" autoFocus aria-label="filter name" maxLength={NAME_MOST} value={naming}
                onChange={(e) => setNaming(e.target.value)} onBlur={() => setNaming(null)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") { e.preventDefault(); saveAs(naming); }
                  else if (e.key === "Escape") { e.stopPropagation(); setNaming(null); }
                }} />
            ))}
          {/* Search leaves archived things out, so the archive is offered before a duplicate is made. */}
          {nothing && rows.length === 0 && (
            <div className="rows-empty">
              Nothing matches.{" "}
              <button type="button" className="word-button" onClick={() => { findInArchive(query); navigate(surface("archive")); }}>
                Look in the Archive
              </button>
            </div>
          )}
          {failed !== null && <div className="rows-empty">{failed}</div>}
        </div>
      )}
      {/* Search is a place of its own (the bar and the rail go there): nothing to close. */}
    </div>
  );
}
