import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import type { DateOnly, SmartToken, Today, TodayTask, Tree } from "@vemi/shared";
import { api, paths } from "../api.js";
import type { Coming } from "../comingUp.js";
import { useExtras } from "../extras.js";
import { dayStamp } from "../format.js";
import { addLine, todayPicked } from "../newTask.js";
import { isStray, type LastTick } from "../tickGuard.js";
import { tasksSender } from "../tasksSender.js";
import { useResource } from "../state/resources.js";
import { laterPlan, moveTo, todayView, type TodayView as View } from "../todayView.js";
import { tickTask } from "../tickTask.js";
import { indexTree } from "../treeIndex.js";
import { useLevelWords } from "../levelNames.js";
import { changeFirstRunStep, useFirstRun } from "../firstRunState.js";
import { homeScreenStep, nextStep } from "../firstRunSteps.js";
import { useInstallOffer } from "../installPrompt.js";
import { chooseNewTaskVenture, homeVentureId, refreshNewTaskVenture, useApp, useNewTaskVenture } from "./appContext.js";
import { AppLockOfferHere } from "./AppLockOffer.js";
import { Chip } from "./Chip.js";
import { Pending } from "./controls.js";
import { isLocal } from "../local/mode.js";
import { FirstRunHome } from "./FirstRunHome.js";
import { FirstRunRemind } from "./FirstRunRemind.js";
import { Ring } from "./Rings.js";
import { SmartChips } from "./SmartChips.js";
import { useSmartTitle } from "./useSmartTitle.js";
import { TaskOptions } from "./TaskOptions.js";
import { TodayMeta, TodayRow } from "./TodayRow.js";
import { Tip } from "./Tip.js";
import "./today.css";

/** What the screen draws and what it does about it. The screen below owns the data. */
export interface TodayScreenProps {
  readonly view: View;
  readonly on: DateOnly;
  readonly whereOf: (task: TodayTask) => string;
  readonly draft: string;
  /** What was read from the draft: a date, a repeat or a time. */
  readonly chips: readonly SmartToken[];
  readonly onRestore: (chip: SmartToken) => void;
  /** The task that was just finished, so its box pops once. */
  readonly popped: string | null;
  readonly foldOpen: boolean;
  /** The tick that cleared the day just happened: the burst plays once. */
  readonly burst: boolean;
  readonly onDraft: (text: string) => void;
  readonly onAdd: () => void;
  readonly onCompose: () => void;
  readonly onTick: (task: TodayTask) => void;
  readonly onLater: (task: TodayTask) => void;
  /** Due tomorrow and off today: the way on for a task that is already late. */
  readonly onTomorrow: (task: TodayTask) => void;
  readonly onOpen: (id: string) => void;
  readonly onOptions: (task: TodayTask) => void;
  readonly onPull: (task: Coming) => void;
  readonly onFold: () => void;
  /** The space the add box files into, drawn as a chip. Left out when there is no space yet. */
  readonly home?: string | null;
  /** Moves the add box on to the next space, and keeps that as where new tasks go. */
  readonly onHome?: () => void;
}

/**
 * Today as the mock draws it: the day and how far through it you are, a box to add to it,
 * the one task to do next, then the rest. With nothing picked or overdue only the box is
 * there; the tool volunteers nothing else. Drawn from props, so it is the same on every path.
 */
export function TodayScreen(p: TodayScreenProps) {
  const { view } = p;
  const words = useLevelWords();
  const extras = useExtras();
  const nothing = view.total === 0 && view.finished.length === 0;
  const cleared = view.next === null && view.finished.length > 0;
  const rows = (tasks: readonly TodayTask[], done: boolean) =>
    tasks.map((t) => (
      <TodayRow key={t.id} task={t} where={p.whereOf(t)} on={p.on} done={done} pop={p.popped === t.id}
        onTick={p.onTick} onOpen={p.onOpen} onOptions={p.onOptions} />
    ));

  return (
    <div className="today">
      <div className="today-head">
        <h2 className="surface-title">Today</h2>
        <span className="today-stamp">{dayStamp(p.on)}</span>
        {view.total > 0 && (
          <span className="today-prog">
            <Ring size="card" value={view.done} share={view.done / view.total} label={`${view.done} of ${view.total} done`} />
            <span><b>{view.done}</b> of {view.total} done</span>
          </span>
        )}
      </div>

      <form className="today-add" onSubmit={(e) => { e.preventDefault(); p.onAdd(); }}>
        <input dir="auto" value={p.draft} onChange={(e) => p.onDraft(e.target.value)} placeholder="Add to today" aria-label="Add to today" autoComplete="off" />
        <button type="submit" className="primary-button" disabled={p.draft.trim() === ""}>Add</button>
      </form>
      <SmartChips chips={p.chips} onRestore={p.onRestore} />
      {/* Where the line above files a task, said as such (a bare space name read as a filter),
          and the full Add for a date, a project or a priority, carrying what was typed. */}
      <div className="today-home">
        {p.home != null && p.onHome !== undefined && (
          <>
            <span className="today-home-label">Goes to</span>
            <Chip aria-label={`New ${words.tasks.toLowerCase()} go to ${p.home}. Press for the next ${words.space.toLowerCase()}`} onClick={p.onHome}>{p.home} ›</Chip>
          </>
        )}
        <span className="fill" />
        <button type="button" className="back-link today-more" onClick={p.onCompose}>More options</button>
      </div>

      {!nothing && view.next !== null && (
        <section className="next-up" aria-label="Next up">
          <span className="next-up-kicker">Next up</span>
          <h3 className="next-up-title">
            <button type="button" dir="auto" onClick={() => p.onOpen(view.next!.id)}>{view.next.title}</button>
          </h3>
          <TodayMeta task={view.next} where={p.whereOf(view.next)} on={p.on} />
          <div className="next-up-actions">
            <button type="button" className="primary-button" onClick={() => p.onTick(view.next!)}>Done</button>
            {/* Overdue goes first whatever its place, so Later would leave it where it is. What
                a late task wants is a new day. */}
            {view.next.overdue
              ? <button type="button" className="quiet-button" onClick={() => p.onTomorrow(view.next!)}>Tomorrow</button>
              : <button type="button" className="quiet-button" onClick={() => p.onLater(view.next!)}>Later today</button>}
          </div>
        </section>
      )}

      {!nothing && (view.also.length > 0 || view.finished.length > 0) && (
        <section className="today-also">
          {view.also.length > 0 && <h3 className="today-also-head">Also today</h3>}
          <div className="today-list">
            {cleared && (
              <div className="clear">
                <div className="clear-ring">
                  <Ring size="plate" value={view.finished.length} share={1} label={`${view.finished.length} done`} />
                  {p.burst && (
                    <div className="clear-burst" aria-hidden="true">
                      {Array.from({ length: 14 }, (_, i) => (
                        <b key={i} style={{ "--r": `${i * 26}deg`, animationDelay: `${(i % 3) * 40}ms` } as CSSProperties} />
                      ))}
                    </div>
                  )}
                </div>
                <h3 className="clear-title">Day cleared</h3>
                <p className="clear-text">
                  {view.finished.length} done{view.coming.length > 0 ? ". Pull something forward or call it." : "."}
                </p>
              </div>
            )}
            {rows(view.also, false)}
            {view.finished.length > 0 && (
              <button type="button" className="today-fold" aria-expanded={p.foldOpen} onClick={p.onFold}>
                {p.foldOpen ? "Hide" : "Show"} {view.finished.length} done
              </button>
            )}
            {p.foldOpen && rows(view.finished, true)}
          </div>
        </section>
      )}

      {extras.comingUp && view.coming.length > 0 && (
        <section className="today-coming" aria-label="Coming up">
          <h3 className="today-also-head">Coming up</h3>
          <div className="today-list">
            {view.coming.map((c) => (
              <div key={c.id} className="trow coming-row">
                <span aria-hidden="true" />
                <button type="button" dir="auto" className="trow-title" onClick={() => p.onOpen(c.id)}>
                  <b>{c.title}</b>
                  <small className="trow-meta"><span>{dayStamp(c.date)}</span></small>
                </button>
                <button type="button" className="pull" aria-label={`Do ${c.title} today`} onClick={() => p.onPull(c)}>Do today</button>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

/** The burst plays once a day. A device that cannot remember simply plays it again. */
function burstSpent(on: DateOnly): boolean {
  try {
    const key = `vemi.cleared.${on}`;
    if (localStorage.getItem(key) !== null) return true;
    localStorage.setItem(key, "1");
    return false;
  } catch {
    return false;
  }
}

/**
 * The Today screen: the account's day, from `/api/today` and the tree. Every change goes
 * through `app.act` with the way back, so undo and redo carry it. The options button opens
 * the task's options sheet; Coming up's Do today picks a task with the undo notice.
 */
export function TodayView() {
  const app = useApp();
  const lastTick = useRef<LastTick | null>(null);
  const chosenHome = useNewTaskVenture();
  // First run's steps 6 and 7 sit above the list, so the task just picked stays in view.
  const firstRun = useFirstRun();
  const homeOffer = useInstallOffer();
  const homeScreen = homeScreenStep({ phone: app.phone, standalone: false, offer: homeOffer, local: isLocal() });
  useEffect(() => { void refreshNewTaskVenture(); }, []);
  const today = useResource<Today>(paths.today);
  const tree = useResource<Tree>(paths.tree);
  const index = useMemo(() => (tree.data === null ? null : indexTree(tree.data)), [tree.data]);
  // A tick moves the task before the Worker answers. The next answer replaces it.
  const [ticked, setTicked] = useState<ReadonlyMap<string, boolean>>(new Map());
  const [popped, setPopped] = useState<string | null>(null);
  const [foldOpen, setFoldOpen] = useState(false);
  const [burst, setBurst] = useState(false);
  const extras = useExtras();
  const [optionsId, setOptionsId] = useState<string | null>(null);
  // The typed text, read for a date, a repeat and a time; the task is made from what is left.
  const smart = useSmartTitle();
  const draft = smart.text;
  useEffect(() => setTicked(new Map()), [today.data, tree.data]);

  const shown = useMemo<Today | null>(
    () => today.data === null ? null : {
      ...today.data,
      tasks: today.data.tasks.map((t) => {
        const done = ticked.get(t.id);
        return done === undefined ? t : { ...t, stateKind: done ? "finished" : "not_started" };
      }),
    },
    [today.data, ticked],
  );

  if (today.data === null || shown === null || index === null || tree.data === null) {
    const waiting = today.data === null ? today : tree;
    return <Pending error={waiting.error} onRetry={waiting.refetch} />;
  }

  const on = today.data.on;
  const view = todayView(shown, tree.data, on);

  /** Where a task is from: its project, or its space when it has none. */
  const whereOf = (t: TodayTask): string => index.tasks.get(t.id)?.project?.name ?? index.ventures.get(t.ventureId)?.name ?? "";

  const tick = (t: TodayTask): void => {
    const at = index.tasks.get(t.id);
    if (at === undefined) return;
    if (isStray(lastTick.current, t.id, Date.now())) return;
    lastTick.current = { id: t.id, at: Date.now() };
    const done = t.stateKind === "finished" || ticked.get(t.id) === true;
    const moved = tickTask({ act: app.act, update: api.update, archive: api.archive, notify: app.notify }, at.task, at.venture, done);
    if (moved === null) return;
    // Said, with its way back, as every other change on Today is. A tick kept on this device is
    // already said by the kept notice.
    void moved.then((outcome) => {
      if (outcome === "sent") app.notify(done ? `Reopened ${t.title}.` : `Done: ${t.title}.`, { undo: true });
    });
    setTicked(new Map(ticked).set(t.id, !done));
    setPopped(done ? null : t.id);
    // The tick that leaves nothing open clears the day; only that tick bursts, and only once a day.
    const open = shown.tasks.filter((x) => x.id !== t.id && x.stateKind !== "finished").length;
    setBurst(extras.burst && !done && open === 0 && !burstSpent(on));
  };

  /** Later today: to the end of the day's own order. Tasks with no place yet are placed first, so this one lands last. */
  const later = (t: TodayTask): void => {
    const steps = laterPlan(shown, view, t.id);
    if (steps.length === 0) return;
    const write = (forward: boolean) => () =>
      Promise.all(steps.map((s) => api.update("tasks", s.id, { todayPosition: forward ? s.to : s.from })));
    void app.act(write(true), {
      what: `moved ${t.title} later today`,
      undo: write(false),
      redo: write(true),
    });
  };

  /** Tomorrow, for a late task: due tomorrow and off today's list, as Move to does it. */
  const tomorrow = (t: TodayTask): void => {
    const was = index.tasks.get(t.id)?.task;
    const back = { dueOn: was?.dueOn ?? null, pickedOn: was?.pickedOn ?? null };
    const patch = moveTo("tomorrow", on);
    void app.act(() => api.update("tasks", t.id, { ...patch }), {
      what: `moved ${t.title} to tomorrow`,
      undo: () => api.update("tasks", t.id, back),
      redo: () => api.update("tasks", t.id, { ...patch }),
    });
  };

  /** Coming up: pick the task for today. The old pick, if any, is what undo puts back. */
  const pull = (c: Coming): void => {
    const was = index.tasks.get(c.id)?.task.pickedOn ?? null;
    void app.act(() => api.update("tasks", c.id, { pickedOn: on }), {
      what: `added ${c.title} to today`,
      undo: () => api.update("tasks", c.id, { pickedOn: was }),
      redo: () => api.update("tasks", c.id, { pickedOn: on }),
    }).then((ok) => {
      if (ok === "sent") app.notify("Added to today.", { undo: true });
    });
  };

  const optionsTask = optionsId === null ? undefined : today.data.tasks.find((x) => x.id === optionsId);

  /**
   * The space the person chose for new tasks, else the one used last, else the first there
   * is. A choice that is no longer a space (archived) falls through. With none, Add has
   * nowhere to put it.
   */
  const home = (): { readonly id: string; readonly name: string } | null => {
    const want = chosenHome ?? homeVentureId();
    return (want === null ? undefined : index.ventures.get(want)) ?? index.ordered[0] ?? null;
  };

  /** The chip: on to the next space, kept as where new tasks go. */
  const nextHome = (): void => {
    const now = home();
    if (now === null || index.ordered.length < 2) return;
    const at = index.ordered.findIndex((v) => v.id === now.id);
    const next = index.ordered[(at + 1) % index.ordered.length];
    if (next !== undefined) chooseNewTaskVenture(next.id);
  };

  const compose = (): void => {
    const venture = home();
    app.compose({ onToday: true, ...(venture === null ? {} : { ventureId: venture.id }), ...(draft.trim() === "" ? {} : { title: draft.trim() }) });
  };

  const add = (): void => {
    const venture = index.ventures.get(home()?.id ?? "") ?? null;
    if (venture === null) {
      compose();
      return;
    }
    void addLine(tasksSender(app), smart.title, venture, todayPicked(venture.id, on, smart.picked)).then((empty) => {
      if (empty) smart.setText("");
    });
  };

  return (
    <div className="today-col">
      {firstRun.step === 6 && <FirstRunRemind onDone={() => changeFirstRunStep(nextStep(6, homeScreen))} />}
      {firstRun.step === 7 && homeOffer !== null && <FirstRunHome offer={homeOffer} onDone={() => changeFirstRunStep(null)} />}
      <AppLockOfferHere />
      <Tip name="today" />
      <TodayScreen view={view} on={on} whereOf={whereOf} draft={draft} chips={smart.chips} onRestore={smart.restore} popped={popped} foldOpen={foldOpen} burst={burst}
        onDraft={smart.setText} onAdd={add} onCompose={compose} onTick={tick} onLater={later} onTomorrow={tomorrow}
        onOpen={app.openTask} onOptions={(t) => setOptionsId(t.id)} onPull={pull} onFold={() => setFoldOpen(!foldOpen)}
        home={home()?.name ?? null} onHome={nextHome} />
      {optionsTask !== undefined && <TaskOptions key={optionsTask.id} task={optionsTask} on={on} onClose={() => setOptionsId(null)} />}
    </div>
  );
}
