import { useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { PRIORITIES, type Tag, type TaskWithBlocker, type Tree } from "@vemi/shared";
import { api, paths } from "../api.js";
import type { Outcome } from "../outcome.js";
import { applyTo, changing, counted, revert, type Change } from "../bulkEdit.js";
import { inOrder, pathOf } from "../projectNest.js";
import { columnsFor, GROUPINGS, type Grouping } from "../boardGroups.js";
import { rememberGrouping, savedGrouping } from "../boardMemory.js";
import { moveAcross, sameColumns, stepInColumn, withMoves, type Moved } from "../boardMoves.js";
import { columnPrefill, makeTask, makeTasks, type Prefill } from "../newTask.js";
import { oncePerFrame } from "../oncePerFrame.js";
import { tasksSender } from "../tasksSender.js";
import { place } from "../order.js";
import { useResource } from "../state/resources.js";
import { tagIndex } from "../tagIndex.js";
import { indexTree, kindOf, orderedStates } from "../treeIndex.js";
import { useLevelWords } from "../levelNames.js";
import { useApp } from "./appContext.js";
import { Chip } from "./Chip.js";
import { MoreMenu } from "./Menu.js";
import { navigate, taskPage } from "../router.js";
import { pastedMany, Pending, StateDot } from "./controls.js";
import { BarPick, SelectionBar, TaskBarPicks } from "./SelectionBar.js";
import { TaskMarks } from "./TaskMarks.js";
import { useSelection } from "./useSelection.js";

/** A move the tree has not shown yet. Past this, the tree is taken as right whatever it says. */
const SETTLE_MS = 15_000;

/** A press that travels less than this is a click, and opens the task. */
const SLOP = 4;


/** The card a drop at this height goes before: the first whose middle is below the pointer. */
function cardBelow(column: HTMLElement, y: number, skip: string | null): string | null {
  for (const card of column.querySelectorAll<HTMLElement>("[data-task]")) {
    const id = card.dataset.task ?? null;
    if (id === null || id === skip) continue;
    const box = card.getBoundingClientRect();
    if (y < box.top + box.height / 2) return id;
  }
  return null;
}

interface Carry {
  readonly id: string;
  readonly from: string;
  readonly title: string;
  readonly x0: number;
  readonly y0: number;
}

/**
 * A venture's tasks, in the columns of whichever grouping is chosen (VEMI-006, VEMI-009).
 *
 * A column is a grouping, not a state: state or project, and the choice is
 * the venture's own and held between visits. The columns auto-fit and wrap rather than
 * squeeze. Pick a card up and a ghost follows the pointer; the column under the pointer is
 * the one `pointerenter` last named, which is why the ghost never takes a pointer event.
 * Let go and the grouping's own field changes, and it goes on the undo stack.
 *
 * **Only the state grouping reorders a column by hand.** `position` is the order of the
 * state board's column, so a drag under any other grouping that wrote it would silently
 * reorder a board nobody is looking at. Under the project grouping a drop in place says so and
 * changes nothing.
 */
export function BoardView({ ventureId, projectId = null }: {
  readonly ventureId: string;
  /** A project's page shows its own tasks on the same board, and adds new ones to it. */
  readonly projectId?: string | null;
}) {
  const app = useApp();
  const w = useLevelWords();
  const one = w.task.toLowerCase();
  const many = w.tasks.toLowerCase();
  /** The word a group-by chip carries. */
  const groupingName: Record<Grouping, string> = { state: "State", project: w.project };
  const tree = useResource<Tree>(paths.tree);
  const tags = useResource<Tag[]>(paths.list("tags"));
  const index = useMemo(() => (tree.data === null ? null : indexTree(tree.data)), [tree.data]);
  // Held steady, because the grouping and the settle pass both hang off it.
  const every = useMemo(() => tags.data ?? [], [tags.data]);
  // A project's page groups by everything but project: every card on it is that project's.
  const offered = useMemo(() => (projectId === null ? [...GROUPINGS] : GROUPINGS.filter((g) => g !== "project")), [projectId]);
  const [grouping, setGroupingRaw] = useState<Grouping>(() => {
    const saved = savedGrouping(ventureId);
    return projectId === null || saved !== "project" ? saved : "state";
  });
  const [moved, setMoved] = useState<ReadonlyMap<string, Moved>>(new Map());
  const [filter, setFilter] = useState("");
  const [onlyBlocked, setOnlyBlocked] = useState(false);
  const chooser = useSelection();
  // What is in the hand, set once as the press becomes a drag. Where the ghost is drawn is
  // not state: it is written straight onto the ghost, so the board is not drawn again for
  // every pixel the pointer travels.
  const [carried, setCarried] = useState<{ readonly id: string; readonly title: string } | null>(null);
  const ghostAt = useRef({ x: 0, y: 0 });
  const ghostEl = useRef<HTMLDivElement | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const [before, setBefore] = useState<string | null>(null);
  const press = useRef<Carry | null>(null);
  const overRef = useRef<string | null>(null);
  const beforeRef = useRef<string | null>(null);
  const justDragged = useRef(false);
  const carrying = useRef(false);
  const columnEls = useRef(new Map<string, HTMLElement>());
  const commit = useRef<(carry: Carry, to: string, beforeId: string | null) => void>(() => undefined);
  /** Whether a drop's height means anything: only the state grouping orders a column by hand. */
  const orderable = useRef(true);

  // A move clears when the tree shows the task where it was put. Not on any answer: one that
  // left before the write landed would put the card back where it came from. A move made
  // under another grouping is let go of here too: its columns are not these columns.
  useEffect(() => {
    if (index === null) return;
    setMoved((current) => {
      if (current.size === 0) return current;
      const now = Date.now();
      const next = new Map<string, Moved>();
      for (const [id, m] of current) {
        const located = index.tasks.get(id);
        if (located === undefined || m.grouping !== grouping || now - m.at > SETTLE_MS) continue;
        const sits = columnsFor(located.venture, grouping).filter((c) => c.tasks.some((t) => t.id === id)).map((c) => c.key);
        const settled = sameColumns(sits, m.keys)
          && (m.fields.position === undefined || located.task.position === m.fields.position);
        if (!settled) next.set(id, m);
      }
      return next.size === current.size ? current : next;
    });
  }, [index, grouping]);

  // The drag lives on the window: a pointer that leaves the card, or the board, still puts it down.
  useEffect(() => {
    // One pass a frame (`oncePerFrame.ts`). A pass reads the column's card boxes, and reading
    // them after each write to the ghost would lay the page out again for every event.
    const frame = oncePerFrame((e: PointerEvent): void => {
      const c = press.current;
      if (c === null) return;
      if (!carrying.current && Math.hypot(e.clientX - c.x0, e.clientY - c.y0) < SLOP) return;
      const col = overRef.current === null || !orderable.current ? undefined : columnEls.current.get(overRef.current);
      const b = col === undefined ? null : cardBelow(col, e.clientY, c.id);
      if (b !== beforeRef.current) {
        beforeRef.current = b;
        setBefore(b);
      }
      ghostAt.current = { x: e.clientX, y: e.clientY };
      if (!carrying.current) {
        carrying.current = true;
        setCarried({ id: c.id, title: c.title });
      }
      const ghost = ghostEl.current;
      if (ghost !== null) {
        ghost.style.left = `${e.clientX + 12}px`;
        ghost.style.top = `${e.clientY - 14}px`;
      }
    });
    const move = (e: PointerEvent): void => {
      if (press.current !== null) frame.push(e);
    };
    const up = (): void => {
      // The last move still waiting for its frame says where this lands.
      frame.flush();
      const c = press.current;
      press.current = null;
      if (c !== null && carrying.current) {
        justDragged.current = true;
        window.setTimeout(() => { justDragged.current = false; }, 0);
        if (overRef.current !== null) commit.current(c, overRef.current, beforeRef.current);
      }
      carrying.current = false;
      setCarried(null);
      setOver(null);
      setBefore(null);
      overRef.current = null;
      beforeRef.current = null;
    };
    const key = (e: KeyboardEvent): void => {
      if (e.key !== "Escape" || press.current === null) return;
      frame.drop();
      press.current = null;
      carrying.current = false;
      setCarried(null);
      setOver(null);
      setBefore(null);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
    window.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      window.removeEventListener("keydown", key);
      frame.drop();
    };
  }, []);

  const chosen = index?.ventures.get(ventureId) ?? null;
  if (index === null) return <Pending error={tree.error} onRetry={tree.refetch} />;
  if (chosen === null) return null;

  const projects = new Map(chosen.projects.map((p) => [p.id, p.name]));
  const states = orderedStates(chosen);
  const columns = withMoves(columnsFor(chosen, grouping), moved, grouping);
  /**
   * A task made here is made the one way Add makes one. No position is sent: the Worker puts
   * a new task after every other in the venture, which is the foot of whichever column it
   * lands in.
   */
  const send = { act: (work: () => Promise<unknown>) => app.act(work), create: api.create };
  const needle = filter.trim().toLowerCase();
  const shows = (t: TaskWithBlocker): boolean =>
    (projectId === null || t.projectId === projectId)
    && (needle === "" || t.title.toLowerCase().includes(needle)) && (!onlyBlocked || t.blocker !== null);

  const setGrouping = (next: Grouping): void => {
    setGroupingRaw(next);
    // The choice is the venture's, so a project's page reads it and never writes it: a
    // grouping picked there is for the page you are on, not for the venture's own board.
    if (projectId === null) rememberGrouping(ventureId, next);
  };

  /**
   * Every card once, whichever columns it is in. A tag grouping puts a task carrying two
   * tags in two columns, so the flat list a selection is counted and written over has to
   * be taken by id or every bulk write would go twice.
   */
  const everyCard = [...new Map(columns.flatMap((c) => c.tasks).map((t) => [t.id, t] as const)).values()];
  /** Every shown card, column by column: the order shift-extend walks. */
  const onScreen = [...new Set(columns.flatMap((c) => c.tasks.filter(shows).map((t) => t.id)))];
  const picked = onScreen.filter((id) => chooser.has(id));
  const pickedTasks = everyCard.filter((t) => picked.includes(t.id));

  /**
   * One change over everything selected, and the way back. Decision 9, with decision 20's
   * rule: only the records the change would actually change are written or undone.
   *
   * `dragsAlong` is what the change takes with it: a field the Worker would rewrite anyway, named
   * so the way back names it too. Moving a task to another project clears its milestone
   * server-side, and an undo that restored only `projectId` would clear it a second time
   * and lose it for good. It is the drop's own discipline, at `moveAcross`, and the two
   * paths write a project move the same way on purpose.
   *
   * It is deliberately no part of what counts as a change: a task already in that project
   * is not moved, and must not have its milestone taken off for standing still.
   */
  const bulk = (patch: Readonly<Record<string, unknown>>, what: string, dragsAlong: Readonly<Record<string, unknown>> = {}): void => {
    const real = changing(pickedTasks, patch);
    const whole = { ...patch, ...dragsAlong };
    bulkEach({ forward: applyTo(real, whole), back: revert(real, whole) }, what);
  };

  /** A change with a patch of its own for each record: a tag on or off, a move to another venture. */
  const bulkEach = ({ forward, back }: Change, what: string): void => {
    if (forward.length === 0) {
      app.notify(`Already ${what}.`);
      return;
    }
    const writeEach = (ps: readonly { readonly id: string; readonly patch: Readonly<Record<string, unknown>> }[]) =>
      Promise.all(ps.map((pl) => api.update("tasks", pl.id, pl.patch)));
    const done = `${what} for ${counted(forward.length, one, many)}`;
    void app.act(() => writeEach(forward), {
      what: done,
      undo: () => writeEach(back),
      redo: () => writeEach(forward),
    }).then((ok) => {
      if (!ok) return;
      chooser.stop();
      // Said as Space says its own, so a change to many cards is never silent. A change only
      // kept on this device has its own notice already, and is not said over.
      if (ok === "sent") app.notify(done.charAt(0).toUpperCase() + done.slice(1), { undo: true });
    });
  };

  /**
   * Archive these tasks as one step, undone as one, and say so. Nothing is deleted: the
   * archive keeps them. `finished` names them in the notice: the task word, or "finished" before it.
   */
  const archiveAll = (ids: readonly string[], finished: boolean): Promise<Outcome> => {
    if (ids.length === 0) return Promise.resolve(false);
    return app.act(() => Promise.all(ids.map((id) => api.archive("tasks", id))), {
      what: `archived ${counted(ids.length, one, many)}`,
      undo: () => Promise.all(ids.map((id) => api.unarchive("tasks", id))),
      redo: () => Promise.all(ids.map((id) => api.archive("tasks", id))),
    }).then((ok) => {
      if (ok === "sent") app.notify(`Archived ${counted(ids.length, finished ? `finished ${one}` : one, finished ? `finished ${many}` : many)}. The archive keeps ${ids.length === 1 ? "it" : "them"}.`, { undo: true });
      return ok;
    });
  };

  const bulkArchive = (): void => {
    void archiveAll(pickedTasks.map((t) => t.id), false).then((ok) => {
      if (ok) chooser.stop();
    });
  };

  /**
   * What a column head's ⋯ offers: everything shown in it, chosen at once, and on a column of
   * a finished state the one step that clears it. Archiving them is undoable and names how
   * many; it is a press a person makes, never something the board does by itself.
   */
  const columnItems = (shown: readonly TaskWithBlocker[], finished: boolean) => shown.length === 0 ? [] : [
    {
      label: `Select all ${shown.length} here`,
      run: () => {
        chooser.setOn(true);
        chooser.replace([...new Set([...picked, ...shown.map((t) => t.id)])]);
      },
    },
    ...(finished ? [{
      label: `Archive all ${counted(shown.length, `finished ${one}`, `finished ${many}`)}`,
      tone: "remove" as const,
      run: () => void archiveAll(shown.map((t) => t.id), true),
    }] : []),
  ];

  /** Show a move before the Worker has answered it, and the way to take that back. */
  const showing = (fields: ReadonlyMap<string, Partial<TaskWithBlocker>>, keys: readonly string[]) => {
    const now = Date.now();
    const shown = (): void => setMoved((current) => {
      const next = new Map(current);
      for (const [id, f] of fields) next.set(id, { grouping, keys, fields: f, at: now });
      return next;
    });
    const forget = (): void => setMoved((current) => {
      const next = new Map(current);
      for (const id of fields.keys()) next.delete(id);
      return next;
    });
    return { shown, forget };
  };

  /**
   * A drop across columns under a grouping that is not state. `moveAcross` says what to
   * write, what it replaces and where the card ends up; this sends it and stacks the undo.
   */
  const acrossColumns = (task: TaskWithBlocker, to: string): void => {
    const made = moveAcross(task, to, columns);
    const { shown, forget } = showing(new Map([[task.id, made.fields]]), made.keys);
    shown();
    void app.act(() => api.update("tasks", task.id, made.fields), {
      what: `moved ${task.title} to ${made.name}`,
      undo: () => {
        forget();
        return api.update("tasks", task.id, made.was);
      },
      redo: () => {
        forget();
        return api.update("tasks", task.id, made.fields);
      },
    }).then((ok) => {
      if (ok === false) forget();
      else if (ok === "sent") app.notify(`Moved to ${made.name}`, { undo: true });
    });
  };

  /**
   * Put a task into a column, before one card or at the end, changing the grouping's own
   * field if it came from another column. The way back is every value the move overwrites,
   * read before it is sent: decision 20, drag does not ship without undo.
   */
  const move = (taskId: string, from: string, to: string, beforeId: string | null): void => {
    const column = columns.find((c) => c.key === to);
    const task = everyCard.find((t) => t.id === taskId);
    if (column === undefined || task === undefined) return;

    if (grouping !== "state") {
      if (from === to) {
        // `position` is the order of the state board's column, and that column is a state.
        // A drag here that wrote it would quietly reorder a board nobody is looking at.
        app.notify("Order is kept by state.");
        return;
      }
      acrossColumns(task, to);
      return;
    }

    const rest = column.tasks.filter((t) => t.id !== taskId);
    const found = beforeId === null ? -1 : rest.findIndex((t) => t.id === beforeId);
    const at = found < 0 ? rest.length : found;
    if (from === to && column.tasks.findIndex((t) => t.id === taskId) === at) return;
    const placements = place(rest, taskId, at);
    const was = new Map(everyCard.map((t) => [t.id, t.position] as const));
    const toName = column.name;
    const { shown, forget } = showing(
      new Map(placements.map((p) => [p.id, p.id === taskId ? { stateId: to, position: p.position } : { position: p.position }])),
      [to],
    );
    const writePlacements = (back: boolean) => Promise.all(placements.map((p) => {
      const position = back ? was.get(p.id) ?? p.position : p.position;
      const state = p.id === taskId && from !== to ? { stateId: back ? from : to } : {};
      return api.update("tasks", p.id, { ...state, position });
    }));
    shown();
    void app.act(() => writePlacements(false), {
      what: from === to ? `reordered ${task.title}` : `moved ${task.title} to ${toName}`,
      undo: () => {
        forget();
        return writePlacements(true);
      },
      redo: () => {
        forget();
        return writePlacements(false);
      },
    }).then((ok) => {
      if (ok === false) forget();
      else if (ok === "sent" && from !== to) app.notify(`Moved to ${toName}`, { undo: true });
    });
  };
  commit.current = (carry, to, beforeId) => move(carry.id, carry.from, to, beforeId);
  orderable.current = grouping === "state";

  const pickUp = (t: TaskWithBlocker, from: string) => (e: ReactPointerEvent<HTMLDivElement>): void => {
    // A phone scrolls with the same thumb: its state changes on the sheet, as in VEMI-004.
    if (e.button !== 0 || chooser.on || app.phone) return;
    press.current = { id: t.id, from, title: t.title, x0: e.clientX, y0: e.clientY };
    overRef.current = from;
    setOver(from);
  };

  /**
   * A card one place up or down its column without a pointer: Alt and an arrow on the card,
   * or Move up and Move down on its ⋯, which is also the way on a phone, where a column does
   * not drag. It is the drop's own move, so it is undone the same way. The state board only:
   * no other grouping keeps an order of its own. The card is moved in the page, which takes
   * the focus off it, so the focus is put back on its name.
   */
  const stepCard = (t: TaskWithBlocker, key: string, ids: readonly string[], shownIds: readonly string[], by: -1 | 1): void => {
    const beforeId = stepInColumn(ids, shownIds, t.id, by);
    if (beforeId === undefined) return;
    move(t.id, key, key, beforeId);
    requestAnimationFrame(() => {
      columnEls.current.get(key)?.querySelector<HTMLElement>(`[data-task="${t.id}"] .card-open`)?.focus();
    });
  };

  const cardKey = (t: TaskWithBlocker, key: string, ids: readonly string[], shownIds: readonly string[]) => (e: ReactKeyboardEvent<HTMLButtonElement>): void => {
    if (e.altKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
      if (grouping !== "state" || chooser.on) return;
      e.preventDefault();
      stepCard(t, key, ids, shownIds, e.key === "ArrowUp" ? -1 : 1);
      return;
    }
    if (e.key !== "Enter" && e.key !== " ") return;
    e.preventDefault();
    if (chooser.on) chooser.toggle(t.id, onScreen, e.shiftKey);
    else app.openTask(t.id);
  };

  return (
    <div className="board">
      <div className="venture-bar">
        <div className="controls">
          <input className="control-field" value={filter} placeholder="Filter" aria-label="filter this board"
            onChange={(e) => setFilter(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Escape" && filter !== "") { e.stopPropagation(); setFilter(""); } }} />
          <button type="button" className={`word-button${onlyBlocked ? " on" : ""}`} aria-pressed={onlyBlocked}
            onClick={() => setOnlyBlocked(!onlyBlocked)}>Blocked</button>
          {/* Decision 9. A switch you can see, not a modifier you have to know. */}
          <button type="button" className={`word-button${chooser.on ? " on" : ""}`} aria-pressed={chooser.on}
            onClick={() => chooser.setOn(!chooser.on)}>Select</button>
        </div>
      </div>

      {/* Group by, in the surface rather than the rail: it is this board's, not the tool's. */}
      <div className="board-group">
        <span className="kicker">Group by</span>
        <div className="chips seg">
          {offered.map((g) => (
            <Chip key={g} on={grouping === g} aria-pressed={grouping === g}
              onClick={() => setGrouping(g)}>{groupingName[g]}</Chip>
          ))}
        </div>
      </div>

      {/* How many columns there are, so the grid stops where that many 400px columns would. */}
      <div className="columns" style={{ "--columns": columns.length } as CSSProperties}>
        {columns.map(({ key, name, kind, tasks }) => {
          const shown = tasks.filter(shows);
          const mine = projectId === null ? tasks : tasks.filter((t) => t.projectId === projectId);
          const ids = tasks.map((t) => t.id);
          const shownIds = shown.map((t) => t.id);
          const dropping = carried !== null && over === key;
          return (
            <section key={key} aria-label={name} className={`column${dropping ? " drop-on" : ""}`}
              ref={(el) => {
                if (el === null) columnEls.current.delete(key);
                else columnEls.current.set(key, el);
              }}
              onPointerEnter={() => {
                if (press.current === null) return;
                overRef.current = key;
                setOver(key);
              }}>
              <div className="column-head">
                {/* Only a state column has a dot: colour carries state and nothing else. */}
                <span className="column-name">{kind !== null && <StateDot kind={kind} />}{name}</span>
                <span className="column-tools">
                  <span className="column-count">{shown.length === mine.length ? mine.length : `${shown.length}/${mine.length}`}</span>
                  <MoreMenu label={`column ${name}`} items={columnItems(shown, kind === "finished")} />
                </span>
              </div>
              <div className="column-body">
                {shown.map((t) => {
                  const inHand = carried?.id === t.id;
                  return (
                    // The whole card takes the pointer; its title is the button a keyboard and
                    // a screen reader reach, with the ⋯ beside it rather than inside it.
                    <div key={t.id} data-task={t.id} data-hold
                      className={`task-card${inHand ? " carried" : ""}${chooser.has(t.id) ? " selected" : ""}${dropping && before === t.id ? " drop-before" : ""}`}
                      onPointerDown={pickUp(t, key)}
                      onClick={(e) => {
                        if (justDragged.current) return;
                        if (chooser.on) chooser.toggle(t.id, onScreen, e.shiftKey);
                        else app.openTask(t.id);
                      }}>
                      <div className="task-top">
                        <button type="button" dir="auto" className="card-open task-title" aria-pressed={chooser.on ? chooser.has(t.id) : undefined}
                          aria-keyshortcuts={grouping === "state" ? "Alt+ArrowUp Alt+ArrowDown" : undefined}
                          onKeyDown={cardKey(t, key, ids, shownIds)}>{t.title}</button>
                        <MoreMenu label={`${one} ${t.title}`} className="card-more" items={[
                          { label: "Open", run: () => app.openTask(t.id) },
                          { label: "Open as page", run: () => navigate(taskPage(ventureId, t.id)) },
                          ...(grouping === "state" ? [
                            { label: "Move up", disabled: stepInColumn(ids, shownIds, t.id, -1) === undefined, run: () => stepCard(t, key, ids, shownIds, -1) },
                            { label: "Move down", disabled: stepInColumn(ids, shownIds, t.id, 1) === undefined, run: () => stepCard(t, key, ids, shownIds, 1) },
                          ] : []),
                          {
                            label: t.pickedOn === app.today ? "Take off today" : "Put on today",
                            disabled: app.today === null,
                            run: () => {
                              const on = t.pickedOn === app.today ? null : app.today;
                              void app.act(() => api.update("tasks", t.id, { pickedOn: on }), {
                                what: on === null ? `took ${t.title} off today` : `put ${t.title} on today`,
                                undo: () => api.update("tasks", t.id, { pickedOn: t.pickedOn }),
                                redo: () => api.update("tasks", t.id, { pickedOn: on }),
                              }).then((ok) => { if (ok === "sent") app.notify(on === null ? "Taken off today" : "Put on today", { undo: true }); });
                            },
                          },
                          { label: `Archive ${one}`, tone: "remove", run: () => void app.archive("tasks", t.id, one) },
                        ]} />
                      </div>
                      {/* The card's marks, and nothing in them interactive or held. */}
                      <TaskMarks task={t} today={app.today}
                        kind={grouping === "state" ? null : kindOf(t, chosen)}
                        project={t.projectId !== null && projectId === null && grouping !== "project" ? projects.get(t.projectId) ?? null : null}
                        tags={tagIndex(every, t.tagIds, "").chosen} />
                    </div>
                  );
                })}
                {dropping && orderable.current && before === null && <div className="drop-end" aria-hidden="true" />}
                {shown.length === 0 && mine.length > 0 && <div className="column-empty">None match.</div>}
              </div>
              {/* Every column adds into itself: the venture, the column's own field, and on a
                  project's page that project. A none-column adds the venture alone. */}
              <ColumnAdd name={name} prefill={{ ...columnPrefill(grouping, key), ...(projectId === null ? {} : { projectId }) }}
                onAdd={(title, prefill) => makeTask(send, title, chosen, prefill)}
                onAddMany={async (titles, prefill) => {
                  const made = await makeTasks(tasksSender(app), titles, chosen, prefill);
                  if (made > 0) app.notify(`Added ${made} ${many} to ${name}, one a line.`, { undo: true });
                }}
                onMore={(title, prefill) => app.compose({ ...prefill, ventureId: chosen.id, ...(title === "" ? {} : { title }) })} />
            </section>
          );
        })}
      </div>

      {carried !== null && (
        <div ref={ghostEl} className="drag-ghost fixed" style={{ left: ghostAt.current.x + 12, top: ghostAt.current.y - 14 }}>{carried.title}</div>
      )}

      {chooser.on && picked.length > 0 && (
        <SelectionBar what={`${picked.length} selected`} onClear={chooser.stop}>
          <TaskBarPicks picked={pickedTasks} states={states.map((st) => ({ id: st.id, name: st.name }))} tags={every}
            ventures={index.ordered.filter((v) => v.id !== chosen.id).map((v) => ({ id: v.id, name: v.name }))}
            today={app.today} onPatch={(patch, what) => bulk(patch, what)} onChange={bulkEach} />
          <BarPick label="Priority" options={[...PRIORITIES.map((pr) => ({ id: pr, name: pr })), { id: "", name: "none" }]}
            onPick={(id) => bulk({ priority: id === "" ? null : id }, id === "" ? "priority cleared" : `set to ${id}`)} />
          <BarPick label={w.project} options={[...inOrder(chosen.projects).map((pr) => ({ id: pr.id, name: pathOf(pr, chosen.projects), nested: pr.parentId !== null })), { id: "", name: "none" }]}
            onPick={(id) => bulk(
              { projectId: id === "" ? null : id },
              id === "" ? `taken off its ${w.project.toLowerCase()}` : `moved to ${projects.get(id) ?? `that ${w.project.toLowerCase()}`}`,
              // A milestone belongs to a project, so it cannot survive a move to another
              // one. Named here so the way back restores both, as the drop's does.
              { milestoneId: null },
            )} />
          <button type="button" className="bar-action" onClick={bulkArchive}>Archive</button>
        </SelectionBar>
      )}
    </div>
  );
}

/**
 * A task straight into its column: a quiet word until it is wanted, then one line. Enter
 * makes it with what the column pre-fills. More takes what was typed to Add with the same
 * pre-fill already chosen, where every part of it can be changed before the task is made.
 */
function ColumnAdd({ name, prefill, onAdd, onAddMany, onMore }: {
  readonly name: string;
  readonly prefill: Prefill;
  readonly onAdd: (title: string, prefill: Prefill) => Promise<Outcome | boolean>;
  /** A paste of several lines: one task a line, with the same pre-fill. */
  readonly onAddMany: (titles: readonly string[], prefill: Prefill) => Promise<void>;
  readonly onMore: (title: string, prefill: Prefill) => void;
}) {
  const w = useLevelWords();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  // One add at a time, as `AddLine`: a second Enter while the first is out makes no second task.
  const busy = useRef(false);
  // Closed by Escape, the focus goes back to the word it was opened from rather than to the
  // page: the line that had it is gone. Closed by a click away, it stays where it went.
  const back = useRef(false);
  if (!open) {
    return (
      <button type="button" className="column-add" onClick={() => setOpen(true)}
        ref={(el) => {
          if (el === null || !back.current) return;
          back.current = false;
          el.focus();
        }}>Add a {w.task.toLowerCase()} here</button>
    );
  }
  const submit = async (): Promise<void> => {
    if (text.trim() === "" || busy.current) return;
    busy.current = true;
    try {
      if (await onAdd(text, prefill)) setText("");
    } finally {
      busy.current = false;
    }
  };
  return (
    <form className="column-add-form" onSubmit={(e) => { e.preventDefault(); void submit(); }}
      onBlur={(e) => {
        // Closed when the line is left empty, and not when focus only moved to More.
        if (text.trim() === "" && !e.currentTarget.contains(e.relatedTarget)) setOpen(false);
      }}>
      <input className="control-field" value={text} autoFocus placeholder="What needs doing?" aria-label={`a new ${w.task.toLowerCase()} in ${name}`}
        onChange={(e) => setText(e.target.value)} onPaste={pastedMany((titles) => onAddMany(titles, prefill))}
        onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); back.current = true; setText(""); setOpen(false); } }} />
      <div className="column-add-more">
        <button type="button" className="row-action quiet" onMouseDown={(e) => e.preventDefault()}
          onClick={() => onMore(text.trim(), prefill)}>More</button>
      </div>
    </form>
  );
}
