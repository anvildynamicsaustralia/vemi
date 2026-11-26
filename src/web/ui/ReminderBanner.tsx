import { useEffect, useMemo, useState } from "react";
import type { Tree } from "@vemi/shared";
import { api, paths } from "../api.js";
import { clockOf, onReminder, snoozePatch, type Reminder } from "../reminderEvent.js";
import { useResource } from "../state/resources.js";
import { firstOfKind, indexTree } from "../treeIndex.js";
import { useApp } from "./appContext.js";
import "./reminderBanner.css";

/**
 * The reminder, in the app. It drops from the top with the task and the time. A second
 * reminder replaces the first. A task that has gone, or was archived, shows nothing: a
 * reminder for what is not there would be noise. It is a status region that is always
 * mounted, so a screen reader hears the text arrive.
 */
export function ReminderBanner() {
  const app = useApp();
  const tree = useResource<Tree>(paths.tree);
  const index = useMemo(() => (tree.data === null ? null : indexTree(tree.data)), [tree.data]);
  const [reminder, setReminder] = useState<Reminder | null>(null);

  useEffect(() => onReminder(setReminder), []);

  const at = reminder === null || index === null ? undefined : index.tasks.get(reminder.taskId);
  const close = (): void => setReminder(null);

  const snooze = (): void => {
    if (reminder === null || at === undefined) return;
    const { id, title, remindAt: was } = at.task;
    const patch = snoozePatch(reminder.at);
    close();
    void app
      .act(() => api.update("tasks", id, patch), {
        what: `snoozed ${title} for an hour`,
        undo: () => api.update("tasks", id, { remindAt: was }),
        redo: () => api.update("tasks", id, patch),
      })
      .then((outcome) => {
        if (outcome === "sent") app.notify("Reminder in 1 hour.", { undo: true });
      });
  };

  const finish = (): void => {
    if (at === undefined) return;
    const target = firstOfKind(at.venture, "finished");
    if (target === null) {
      app.notify(`${at.venture.name} has no finished state to move this into.`);
      return;
    }
    const { id, title, stateId: was } = at.task;
    close();
    void app
      .act(() => api.update("tasks", id, { stateId: target.id }), {
        what: `finished ${title}`,
        undo: () => api.update("tasks", id, { stateId: was }),
        redo: () => api.update("tasks", id, { stateId: target.id }),
      })
      .then((outcome) => {
        if (outcome === "sent") app.notify("Done.", { undo: true });
      });
  };

  return (
    <div className={`reminder-banner${reminder !== null && at !== undefined ? " on" : ""}`} role="status">
      {reminder !== null && at !== undefined && (
        <>
          <span className="reminder-text">
            <small className="reminder-when">Reminder · {clockOf(reminder.at)}</small>
            <b className="reminder-title" dir="auto">{at.task.title}</b>
          </span>
          <span className="reminder-actions">
            <button type="button" onClick={close}>Dismiss</button>
            <button type="button" onClick={snooze}>In 1 hour</button>
            <button type="button" className="reminder-done" onClick={finish}>Done</button>
          </span>
        </>
      )}
    </div>
  );
}
