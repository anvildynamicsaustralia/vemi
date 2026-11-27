import { useMemo } from "react";
import type { DateOnly, Today, Tree } from "@vemi/shared";
import { api, paths } from "../api.js";
import { longDate, shortDate } from "../format.js";
import { useLevelWords } from "../levelNames.js";
import { addDays, localToday } from "../monthGrid.js";
import { useResource } from "../state/resources.js";
import { tickTask } from "../tickTask.js";
import { indexTree, kindOf, type Located } from "../treeIndex.js";
import { upcomingCount, upcomingGroups } from "../upcoming.js";
import { useApp } from "./appContext.js";
import { Pending } from "./controls.js";
import { SwipeRow } from "./SwipeRow.js";
import { DaySwitch } from "./DaySwitch.js";
import "./upcoming.css";

type Row = Located & { readonly id: string; readonly title: string; readonly dueOn: DateOnly | null; readonly finished: boolean };

/**
 * Upcoming: two weeks of what is due, day by day, with what is late above it. A row is
 * finished by its box or a swipe right; a swipe left puts it on today, moves it a day, or
 * archives it. Each day has its own + that opens Add on that day.
 */
export function UpcomingView() {
  const app = useApp();
  const words = useLevelWords();
  const tree = useResource<Tree>(paths.tree);
  const day = useResource<Today>(paths.today);
  const today = app.today ?? localToday();
  const rows = useMemo<readonly Row[]>(() => {
    if (tree.data === null) return [];
    return [...indexTree(tree.data).tasks.values()].map((at) => ({
      ...at, id: at.task.id, title: at.task.title, dueOn: at.task.dueOn, finished: kindOf(at.task, at.venture) === "finished",
    }));
  }, [tree.data]);
  if (tree.data === null) return <Pending error={tree.error} onRetry={tree.refetch} />;
  const late = new Set((day.data?.tasks ?? []).filter((t) => t.overdue).map((t) => t.id));
  const groups = upcomingGroups(rows, today, late);
  const count = upcomingCount(groups);
  const task = words.task.toLowerCase();

  const tickSend = { act: app.act, update: api.update, archive: api.archive, notify: app.notify };
  const finish = (r: Row): void => {
    void tickTask(tickSend, r.task, r.venture, false)?.then((ok) => { if (ok === "sent") app.notify(`Done: ${r.title}.`, { undo: true }); });
  };
  const patch = (r: Row, fields: { readonly dueOn?: DateOnly | null; readonly pickedOn?: DateOnly | null }, what: string): void => {
    const back = { dueOn: r.task.dueOn, pickedOn: r.task.pickedOn };
    void app.act(() => api.update("tasks", r.id, fields), {
      what: `${what}: ${r.title}`,
      undo: () => api.update("tasks", r.id, back),
      redo: () => api.update("tasks", r.id, fields),
    }).then((ok) => { if (ok === "sent") app.notify(`${what[0]?.toUpperCase() ?? ""}${what.slice(1)}: ${r.title}.`, { undo: true }); });
  };
  const head = (on: DateOnly | null): string => {
    if (on === null) return "Overdue";
    if (on === today) return "Today";
    if (on === addDays(today, 1)) return "Tomorrow";
    return longDate(on, today);
  };

  return (
    <div className="upcoming">
      <DaySwitch on="upcoming" />
      <div className="upcoming-head">
        <h2 className="surface-title">Upcoming</h2>
        <span className="upcoming-count">{count === 0 ? "Nothing due in the next two weeks" : `${count} due in the next two weeks`}</span>
      </div>
      {groups.map((g) => (
        <section key={g.on ?? "overdue"} className={`upcoming-day${g.on === null ? " late" : ""}${g.tasks.length === 0 ? " empty" : ""}`}
          aria-label={head(g.on)}>
          <div className="upcoming-day-head">
            {/* Today and Tomorrow carry their date too; other days are named with it already. */}
            <h3>{head(g.on)}{(g.on === today || g.on === addDays(today, 1)) && <small>{shortDate(g.on, today)}</small>}</h3>
            {g.tasks.length > 0 && <span className="upcoming-n">{g.tasks.length}</span>}
            <span className="fill" />
            {g.on !== null && (
              <button type="button" className="upcoming-add" aria-label={`Add a ${task} for ${head(g.on)}`}
                onClick={() => app.compose(g.on === today ? { onToday: true } : { dueOn: g.on as DateOnly })}>+</button>
            )}
          </div>
          {g.tasks.map((r) => (
            <SwipeRow key={r.id}
              lead={{ label: "Done", tone: "done", run: () => finish(r) }}
              trail={[
                ...(r.task.pickedOn === today ? [] : [{ label: "Today", run: () => patch(r, { pickedOn: today }, "put on today") }]),
                { label: "+1 day", run: () => patch(r, { dueOn: addDays(r.dueOn ?? today, 1) }, "moved a day") },
                { label: "Archive", tone: "remove" as const, run: () => void app.archive("tasks", r.id, task) },
              ]}>
              <div className="upcoming-row">
                <button type="button" className="trow-box" aria-label={`finish ${r.title}`} onClick={() => finish(r)}><i aria-hidden="true" /></button>
                <button type="button" dir="auto" className="upcoming-title" onClick={() => app.openTask(r.id)}>
                  <b>{r.title}</b>
                  <small>
                    {g.on === null && r.dueOn !== null && <span className="trow-overdue">{shortDate(r.dueOn, today)} · </span>}
                    {r.project?.name ?? r.venture.name}
                    {r.task.pickedOn === today && <span className="upcoming-today"> · on today</span>}
                  </small>
                </button>
              </div>
            </SwipeRow>
          ))}
        </section>
      ))}
    </div>
  );
}
