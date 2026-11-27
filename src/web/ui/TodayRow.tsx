import type { ReactNode } from "react";
import type { DateOnly, TodayTask } from "@vemi/shared";
import { metaParts } from "../todayMeta.js";

/** A task's meta line: Overdue and its date, where it lives, how it repeats, when it reminds. */
export function TodayMeta({ task, where, on }: { readonly task: TodayTask; readonly where: string; readonly on: DateOnly }) {
  const parts = metaParts(task, where, on);
  if (parts.length === 0) return null;
  return (
    <small className="trow-meta">
      {parts.map((p) => <span key={p.kind} className={p.kind === "overdue" ? "trow-overdue" : undefined}>{p.text}</span>)}
    </small>
  );
}

/**
 * One open or finished task in the Also today list: a tick box, a title that opens the task
 * with its meta line under it, and an options button. The row only draws; what a tick or an
 * options press does is the screen's.
 */
export function TodayRow({ task, where, on, done, pop, onTick, onOpen, onOptions, grip = null }: {
  /** The drag handle, when the row is in an ordered list. */
  readonly grip?: ReactNode;
  readonly task: TodayTask;
  readonly where: string;
  readonly on: DateOnly;
  readonly done: boolean;
  /** Just finished: the box pops once. */
  readonly pop: boolean;
  readonly onTick: (task: TodayTask) => void;
  readonly onOpen: (id: string) => void;
  readonly onOptions: (task: TodayTask) => void;
}) {
  return (
    <div className={`trow${done ? " isdone" : ""}${pop ? " pop" : ""}${grip === null ? "" : " has-grip"}`}>
      {grip}
      <button type="button" className="trow-box" aria-label={done ? `reopen ${task.title}` : `finish ${task.title}`}
        aria-pressed={done} onClick={() => onTick(task)}>
        <i aria-hidden="true">{done ? "✓" : ""}</i>
      </button>
      <button type="button" dir="auto" className="trow-title" onClick={() => onOpen(task.id)}>
        <b>{task.title}</b>
        <TodayMeta task={task} where={where} on={on} />
      </button>
      <button type="button" className="trow-more" aria-label={`options for ${task.title}`} onClick={() => onOptions(task)}>
        <span aria-hidden="true">···</span>
      </button>
    </div>
  );
}
