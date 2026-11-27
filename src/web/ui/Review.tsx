import { useMemo, useState, type ReactNode } from "react";
import type { DateOnly, Review, ReviewTask, Tree } from "@vemi/shared";
import { reviewOf, weeklyOn } from "@vemi/shared";
import { api, paths, saveLastReview } from "../api.js";
import { dayStamp } from "../format.js";
import { useLevelWords } from "../levelNames.js";
import type { LevelWords } from "../levelWords.js";
import { addDays } from "../monthGrid.js";
import { makeTasks } from "../newTask.js";
import { useResource } from "../state/resources.js";
import { tasksSender } from "../tasksSender.js";
import { indexTree, kindOf } from "../treeIndex.js";
import { homeVentureId, useApp } from "./appContext.js";
import { Pending } from "./controls.js";
import "./review.css";

/** The steps, then the end. */
export type ReviewStep = 0 | 1 | 2 | 3;

/** What a task being cleared up can be sent to. */
export type ClearChoice = "today" | "tomorrow" | "week";

const STEPS = ["Look back", "Clear up", "Look ahead"] as const;

/**
 * The fields a clear-up choice writes. Today picks the task and makes it due today; the
 * others move the due date, a day or a week on. Nothing here is chosen for the person.
 */
export function clearFields(choice: ClearChoice, on: DateOnly): { readonly pickedOn?: DateOnly; readonly dueOn: DateOnly } {
  if (choice === "today") return { pickedOn: on, dueOn: on };
  return { dueOn: addDays(on, choice === "tomorrow" ? 1 : 7) };
}

export interface ReviewScreenProps {
  readonly step: ReviewStep;
  readonly on: DateOnly;
  readonly review: Review;
  readonly whereOf: (task: ReviewTask) => string;
  readonly words: LevelWords;
  /** The day the review was last finished, or null. */
  readonly doneOn: DateOnly | null;
  /** The weekly task has been made. */
  readonly repeated: boolean;
  readonly onStep: (step: ReviewStep) => void;
  readonly onClear: (task: ReviewTask, choice: ClearChoice | "archive") => void;
  readonly onFinish: () => void;
  readonly onRepeat: () => void;
}

function Row({ task, where, when, children }: {
  readonly task: ReviewTask;
  readonly where: string;
  readonly when?: string | null;
  readonly children?: ReactNode;
}) {
  return (
    <li className="review-row">
      <span className="review-title">{task.title}</span>
      {when ? <span className="review-when">{when}</span> : null}
      {where === "" ? null : <span className="review-where">{where}</span>}
      {children}
    </li>
  );
}

/**
 * The weekly review as three steps and an end: Look back, Clear up, Look ahead. Drawn from
 * props, so it reads the same on every path. Every change it asks for goes out through the
 * owner's handlers, which run them with the way back; nothing on screen is an undo button.
 */
export function ReviewScreen(p: ReviewScreenProps) {
  const { review, words } = p;
  const tasks = words.tasks.toLowerCase();
  const stamp = (date: DateOnly | null): string | null => (date === null ? null : dayStamp(date));

  if (p.step === 3) {
    return (
      <div className="review">
        <h2 className="surface-title">Review done</h2>
        <p className="review-nothing">{p.doneOn === null ? dayStamp(p.on) : dayStamp(p.doneOn)}</p>
        {p.repeated ? null : (
          <div className="review-nav">
            <button type="button" className="review-go" onClick={p.onRepeat}>Repeat every week</button>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="review">
      <h2 className="surface-title">Weekly review</h2>
      {/* The steps are also the way between them: any can be gone back or forward to. */}
      <div className="review-steps seg" role="group" aria-label="Steps">
        {STEPS.map((name, i) => (
          <button key={name} type="button" aria-pressed={i === p.step} aria-current={i === p.step ? "step" : undefined}
            onClick={() => p.onStep(i as ReviewStep)}>{name}</button>
        ))}
      </div>

      {p.step === 0 && (
        review.lookBack.length === 0
          ? <p className="review-nothing">No {tasks} finished in the last 7 days.</p>
          : <ul className="review-list">{review.lookBack.map((t) => <Row key={t.id} task={t} where={p.whereOf(t)} when={stamp(t.updatedAt.slice(0, 10))} />)}</ul>
      )}

      {p.step === 1 && (
        review.clearUp.length === 0
          ? <p className="review-nothing">Nothing to clear up.</p>
          : (
            <ul className="review-list">
              {review.clearUp.map((t) => (
                <Row key={t.id} task={t} where={p.whereOf(t)} when={stamp(t.dueOn)}>
                  <span className="review-actions">
                    <button type="button" className="review-go" onClick={() => p.onClear(t, "today")}>Today</button>
                    <button type="button" className="review-go" onClick={() => p.onClear(t, "tomorrow")}>Tomorrow</button>
                    <button type="button" className="review-go" onClick={() => p.onClear(t, "week")}>Next week</button>
                    <button type="button" className="review-go" onClick={() => p.onClear(t, "archive")}>Archive</button>
                  </span>
                </Row>
              ))}
            </ul>
          )
      )}

      {p.step === 2 && (
        review.lookAhead.length === 0
          ? <p className="review-nothing">No {tasks} due in the next 7 days.</p>
          : <ul className="review-list">{review.lookAhead.map((t) => <Row key={t.id} task={t} where={p.whereOf(t)} when={stamp(t.dueOn)} />)}</ul>
      )}

      <div className="review-nav">
        {p.step > 0 && <button type="button" className="review-go" onClick={() => p.onStep((p.step - 1) as ReviewStep)}>Back</button>}
        {p.step < 2
          ? <button type="button" className="review-go" onClick={() => p.onStep((p.step + 1) as ReviewStep)}>Next</button>
          : <button type="button" className="review-go" onClick={p.onFinish}>Review done</button>}
      </div>
    </div>
  );
}

/**
 * The weekly review: read from the tree already on the page, with the day the Worker says it
 * is. Each action runs through `app.act` with its way back, so undo and redo carry it.
 */
export function ReviewView() {
  const app = useApp();
  const tree = useResource<Tree>(paths.tree);
  const settings = useResource<{ readonly lastReviewOn?: string | null }>(paths.appearance);
  const index = useMemo(() => (tree.data === null ? null : indexTree(tree.data)), [tree.data]);
  const [step, setStep] = useState<ReviewStep>(0);
  const [doneOn, setDoneOn] = useState<DateOnly | null>(null);
  const [repeated, setRepeated] = useState(false);
  const words = useLevelWords();
  const on = app.today;

  const review = useMemo(() => {
    if (index === null || on === null) return null;
    const all: ReviewTask[] = [...index.tasks.values()].map(({ task, venture }) => ({ ...task, finished: kindOf(task, venture) === "finished" }));
    return reviewOf(all, on);
  }, [index, on]);

  if (tree.data === null || index === null || on === null || review === null) {
    return <Pending error={tree.error} onRetry={tree.refetch} />;
  }

  const whereOf = (t: ReviewTask): string => index.tasks.get(t.id)?.project?.name ?? index.ventures.get(t.ventureId)?.name ?? "";

  const clear = (task: ReviewTask, choice: ClearChoice | "archive"): void => {
    if (choice === "archive") {
      void app.act(() => api.archive("tasks", task.id), {
        what: `archived ${task.title}`,
        undo: () => api.unarchive("tasks", task.id),
        redo: () => api.archive("tasks", task.id),
      });
      return;
    }
    const fields = clearFields(choice, on);
    const was = { pickedOn: task.pickedOn, dueOn: task.dueOn };
    void app.act(() => api.update("tasks", task.id, fields), {
      what: `moved ${task.title}`,
      undo: () => api.update("tasks", task.id, was),
      redo: () => api.update("tasks", task.id, fields),
    });
  };

  const finish = (): void => {
    const was = settings.data?.lastReviewOn ?? null;
    void app.act(() => saveLastReview(on), {
      what: "finished the weekly review",
      undo: () => saveLastReview(was),
      redo: () => saveLastReview(on),
    }).then((ok) => {
      if (ok === false) return;
      setDoneOn(on);
      setStep(3);
    });
  };

  /** A "Weekly review" task that repeats every week, in the space new tasks go to. */
  const repeat = (): void => {
    const venture = index.ventures.get(homeVentureId() ?? "") ?? index.ordered[0] ?? null;
    if (venture === null) return;
    void makeTasks(tasksSender(app), ["Weekly review"], venture, {
      ventureId: venture.id, dueOn: addDays(on, 7), repeat: weeklyOn(on),
    }).then((made) => {
      if (made > 0) setRepeated(true);
    });
  };

  return (
    <ReviewScreen step={step} on={on} review={review} whereOf={whereOf} words={words} doneOn={doneOn}
      repeated={repeated} onStep={setStep} onClear={clear} onFinish={finish} onRepeat={repeat} />
  );
}
