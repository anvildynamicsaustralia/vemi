import type { ReactNode } from "react";
import type { Note } from "@vemi/shared";
import { age } from "../format.js";
import { useApp } from "./appContext.js";
import { EditableText } from "./controls.js";
import { LockableText } from "./LockableText.js";

/**
 * One note, wherever notes are listed: a project's page, a venture's About.
 * Its words are edited where they are read, so a typo is a click away rather than an archive
 * and a retype that leaves the old copy in the Archive. The edit goes on the undo stack with
 * the words it replaced, through `edit` as every other text field's does, so a save that
 * did not happen reopens the field with what was typed. Clearing it all is not an edit:
 * archiving is the ×.
 */
export function NoteLine({ note, also }: {
  readonly note: Note;
  /** Said after its age: what it is on, where a list holds notes from more than one place. */
  readonly also?: ReactNode;
}) {
  const app = useApp();
  return (
    <div className="more-line note-line">
      <div className="fill">
        <LockableText kind="notes" id={note.id} field="body" value={note.body}
          save={(body, was) => app.edit("notes", note.id, { body }, { body: was ?? note.body }, "edited a note")}>
          {(editor) => <EditableText value={editor.value ?? ""} placeholder="a note" multiline onSave={editor.onSave} />}
        </LockableText>
        <div className="more-note">{age(note.updatedAt)}{also}</div>
      </div>
      <button type="button" className="close-button" aria-label="archive note" onClick={() => void app.archive("notes", note.id, "note")}>×</button>
    </div>
  );
}
