import { useState } from "react";
import type { DateOnly, Task } from "@vemi/shared";
import { api } from "../api.js";
import { useLevelWords } from "../levelNames.js";
import {
  moveChoice, pressedMove, pressedRemind, pressedRepeat, remindChoice, repeatChoice, undoPatch,
  type Choice, type MoveKey, type RemindKey, type RepeatKey,
} from "../taskOptions.js";
import { useApp } from "./appContext.js";
import { Chip } from "./Chip.js";
import { Sheet } from "./Sheet.js";
import "./taskOptions.css";

const MOVES: readonly (readonly [MoveKey, string])[] = [["today", "Today"], ["tomorrow", "Tomorrow"], ["week", "Next week"]];
const REMINDS: readonly (readonly [RemindKey, string])[] = [["off", "Off"], ["9", "9 am"], ["12", "12 pm"], ["17", "5 pm"], ["pick", "Pick a time"]];
const REPEATS: readonly (readonly [RepeatKey, string])[] = [["never", "Never"], ["daily", "Daily"], ["weekly", "Weekly"], ["monthly", "Monthly"]];

/**
 * A task's options: where it goes, when it reminds, whether it repeats. Every choice saves
 * at once and goes on the undo stack with the notice, so there is no Save. What is pressed is
 * what the task holds; the sheet keeps its own copy of the four fields so a press shows
 * before the next answer from the Worker arrives. Delete archives, which can be undone.
 */
export function TaskOptions({ task, on, onClose }: {
  readonly task: Task;
  readonly on: DateOnly;
  readonly onClose: () => void;
}) {
  const app = useApp();
  const words = useLevelWords();
  const [now, setNow] = useState<Task>(task);
  const [picking, setPicking] = useState(false);
  const [time, setTime] = useState(now.remindAt?.slice(11) ?? "");

  const save = (choice: Choice): void => {
    const before = now;
    const back = undoPatch(before, choice.patch);
    setNow({ ...before, ...choice.patch });
    void app.act(() => api.update("tasks", task.id, choice.patch), {
      what: `${choice.label}: ${task.title}`,
      undo: () => api.update("tasks", task.id, back),
      redo: () => api.update("tasks", task.id, choice.patch),
    }).then((ok) => {
      if (ok === "sent") app.notify(`${choice.label[0]?.toUpperCase() ?? ""}${choice.label.slice(1)}`, { undo: true });
      else if (ok === false) setNow(before);
    });
  };

  const move = pressedMove(now, on);
  const remind = picking ? "pick" : pressedRemind(now);
  const repeat = pressedRepeat(now);

  return (
    <Sheet onClose={onClose} className="task-options" label={`${words.task} options`}>
      <div className="sheet-head"><b className="options-title">{task.title}</b></div>
      <div className="sheet-section options-row">
        <span className="options-label">Move to</span>
        <div className="chips">
          {MOVES.map(([key, word]) => (
            <Chip key={key} on={move === key} aria-pressed={move === key} onClick={() => save(moveChoice(key, on))}>{word}</Chip>
          ))}
        </div>
      </div>
      <div className="sheet-section options-row">
        <span className="options-label">Remind me</span>
        <div className="chips">
          {REMINDS.map(([key, word]) => (
            <Chip key={key} on={remind === key} aria-pressed={remind === key} onClick={() => {
              if (key === "pick") { setPicking(true); return; }
              setPicking(false);
              const choice = remindChoice(key, now, on, null);
              if (choice !== null) save(choice);
            }}>{word}</Chip>
          ))}
        </div>
        {remind === "pick" && (
          <input type="time" className="options-time" aria-label="Reminder time" value={time} onChange={(e) => {
            setTime(e.target.value);
            const choice = remindChoice("pick", now, on, e.target.value);
            if (choice !== null) save(choice);
          }} />
        )}
      </div>
      <div className="sheet-section options-row">
        <span className="options-label">Repeat</span>
        <div className="chips">
          {REPEATS.map(([key, word]) => (
            <Chip key={key} on={repeat === key} aria-pressed={repeat === key} onClick={() => save(repeatChoice(key, now, on))}>{word}</Chip>
          ))}
        </div>
      </div>
      <div className="sheet-foot">
        <button type="button" className="quiet-button" onClick={() => {
          void app.archive("tasks", task.id, words.task.toLowerCase());
          onClose();
        }}>Archive</button>
        <span className="fill" />
        <button type="button" className="primary-button" onClick={onClose}>Done</button>
      </div>
    </Sheet>
  );
}
