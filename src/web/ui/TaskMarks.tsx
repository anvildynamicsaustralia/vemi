import { type DateOnly, type Priority, type StateKind, type TaskWithBlocker } from "@vemi/shared";
import { checklistCount } from "../checklistCount.js";
import { shortDate } from "../format.js";
import { StateDot } from "./controls.js";

/**
 * What a task card carries under its title: two deliberate lines, marks then words.
 *
 * Not a `TaskCard`. The board's card owns the drag and the hold — `data-task`,
 * `data-hold`, the pick-up, the key handler, the drop line — and nothing else wants any of
 * that. This is the meta alone, so Today's rows can take it up later without taking a drag
 * with it.
 *
 * **Layout B**, chosen at the design gate on 2026-09-19. Line one is a tight group of marks
 * with the date pushed right; line two is the words. Two lines rather than one wrapping one,
 * because it is the only shape whose height does not change with the column's width, and a
 * column of cards that all stand the same height is a column you can scan. The grid is
 * `minmax(236px, 1fr)`, which leaves the meta 156px at its narrowest; seven things on one
 * line measured ~430px and were never going to fit.
 *
 * Nothing here is interactive and nothing here is held.
 */
export interface Marks {
  readonly task: TaskWithBlocker;
  /**
   * The task's own state, drawn only when the column is not already one — the same
   * condition the project name is under on a project's page. Null draws nothing.
   */
  readonly kind: StateKind | null;
  /** The project's name, when the surface is not already one project's. Null draws nothing. */
  readonly project: string | null;
  /** Every tag on this task, in name order. One is shown, and the rest are a count. */
  readonly tags: readonly { readonly id: string; readonly name: string }[];
  /** Today, as the Worker says it, for how a date is said. */
  readonly today: DateOnly | null;
}

export function TaskMarks({ task, kind, project, tags, today }: Marks) {
  const count = checklistCount(task.checklist);
  const due = task.dueOn === null ? null : shortDate(task.dueOn, today);
  const marks = kind !== null || task.priority !== null || count.of > 0 || task.blocker !== null;
  const first = tags[0];
  const rest = tags.length - 1;
  return (
    <>
      {(marks || due !== null) && (
        <div className="task-meta">
          <span className="task-marks">
            {kind !== null && <StateDot kind={kind} />}
            {task.priority !== null && <PriorityMark priority={task.priority} />}
            {count.of > 0 && <span className="task-count">{count.said}</span>}
            {task.blocker !== null && <span className="tag-blocked">Blocked</span>}
          </span>
          {due !== null && <span className="task-due">{due}</span>}
        </div>
      )}
      {(project !== null || first !== undefined) && (
        <div className="task-words">
          {project !== null && <span className="task-project">{project}</span>}
          {/* One tag, then a count. Andy's call at the design gate, over the two the
              drawing proposed: one pill reads as what kind of work this is rather than as
              a list to scan, and it fits the 156px floor with room left. The count is not
              a link — the card opens the task, and the task shows all of them. */}
          {/* The tag gives way too, past a width of its own, so a long one cannot squeeze the
              project name down to two letters. The whole name is its tooltip. */}
          {first !== undefined && <span className="pill task-tag" title={first.name}><span className="task-tag-name">{first.name}</span></span>}
          {rest > 0 && <span className="pill">+{rest}</span>}
        </div>
      )}
    </>
  );
}

/** How many of the three bars a priority fills, from the left. */
const BARS: Record<Priority, number> = { low: 1, medium: 2, high: 3 };

/**
 * Priority, as three rising bars filled from the left: one low, two medium, three high.
 *
 * **It cannot be a colour.** All four state-dot colours are spoken for, and `decisions.md`
 * holds that colour carries state and nothing else — a fifth hue here would make orange one
 * of several things instead of "this wants you". Bars read as a quantity without a legend,
 * and a rising row of them is nothing else in this interface: round means state, bars mean
 * priority, and the two can never be read as each other. It is the reasoning the map uses
 * for ownership against a link.
 *
 * On the card the mark stands alone and says nothing to a screen reader, so it carries the
 * word. **Beside its own word it must not**, or the word is read twice: a chip whose label
 * already says "high" would announce "high priority high". `silent` is for that, and it is
 * what `StateDot` does unconditionally — a dot never appears without its state's name.
 */
export function PriorityMark({ priority, silent = false }: { readonly priority: Priority; readonly silent?: boolean }) {
  const filled = BARS[priority];
  return (
    <span className="mark-priority" {...(silent ? { "aria-hidden": true } : { role: "img", "aria-label": `${priority} priority` })}>
      {[0, 1, 2].map((bar) => <span key={bar} className={`bar${bar < filled ? " on" : ""}`} />)}
    </span>
  );
}
