import { useState } from "react";
import type { Outcome } from "../outcome.js";
import { Sheet } from "./Sheet.js";

/**
 * A name, changed in one place: the field holds the name as it is, selected, so typing replaces
 * it. Enter or Save keeps it; Escape, Cancel or a press outside leaves it as it was. A blank
 * name is not a name, so Save waits for one.
 */
export function RenameSheet({ what, name, onRename, onClose }: {
  /** What is being renamed, in the account's words: "space". */
  readonly what: string;
  readonly name: string;
  readonly onRename: (next: string) => Promise<Outcome | boolean>;
  readonly onClose: () => void;
}) {
  const [text, setText] = useState(name);
  const [busy, setBusy] = useState(false);
  const next = text.trim();
  const ready = next !== "" && !busy;
  const save = async (): Promise<void> => {
    if (!ready) return;
    if (next === name.trim()) { onClose(); return; }
    setBusy(true);
    const ok = await onRename(next);
    setBusy(false);
    if (ok !== false) onClose();
  };
  return (
    <Sheet onClose={onClose} className="rename-sheet" placement="centre" label={`rename ${what}`}>
      <div className="sheet-head">
        <span className="label">Rename {what}</span>
        <span className="fill" />
        <button type="button" className="close-button" aria-label="close" onClick={onClose}>×</button>
      </div>
      <form className="sheet-body rename-body" onSubmit={(e) => { e.preventDefault(); void save(); }}>
        <input className="field rename-field" dir="auto" autoFocus value={text} aria-label={`${what} name`}
          onFocus={(e) => e.currentTarget.select()}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); onClose(); } }} />
        <div className="rename-actions">
          <button type="submit" className="primary-button" disabled={!ready}>Save</button>
          <button type="button" className="back-link" onClick={onClose}>Cancel</button>
        </div>
      </form>
    </Sheet>
  );
}
