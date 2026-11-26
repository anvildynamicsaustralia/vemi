import { useState, type KeyboardEvent } from "react";
import type { Note } from "@vemi/shared";
import { createOnce, paths } from "../api.js";
import { useLevelWords } from "../levelNames.js";
import type { Outcome } from "../outcome.js";
import { useResource } from "../state/resources.js";
import { useApp } from "./appContext.js";
import { LockableText, type SaveText } from "./LockableText.js";
import { NoteText } from "./NoteText.js";
import "./projectNotes.css";

/** The log reads newest first by when a note was made; an edit does not move it. */
export const newestFirst = (notes: readonly Note[]): Note[] =>
  [...notes].sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));

type Saved = Promise<Outcome | boolean> | void;

export interface NotesLogProps {
  readonly notes: readonly Note[];
  readonly onAdd: (body: string) => Saved;
  readonly onEdit: (note: Note, body: string, was: string) => Saved;
  readonly onArchive: (note: Note) => void;
}

/** True unless the save answered that it did not happen. */
const happened = (r: Outcome | boolean | void): boolean => r !== false;

/**
 * A project's notes as a dated log (VEMI-013). Presentational: the connected `ProjectNotes`
 * below supplies the writes, so this renders with plain props in a test.
 */
export function NotesLog({ notes, onAdd, onEdit, onArchive }: NotesLogProps) {
  const words = useLevelWords();
  const [draft, setDraft] = useState("");
  const [adding, setAdding] = useState(false);
  const add = async (): Promise<void> => {
    const body = draft.trim();
    if (body === "" || adding) return;
    setAdding(true);
    try {
      if (happened(await onAdd(body))) setDraft("");
    } finally {
      setAdding(false);
    }
  };
  const submitKey = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      void add();
    }
  };
  return (
    <div className="notes-log">
      <form className="notes-add" onSubmit={(e) => { e.preventDefault(); void add(); }}>
        <textarea dir="auto" value={draft} rows={2} placeholder="a short note" aria-label="a short note"
          onChange={(e) => setDraft(e.target.value)} onKeyDown={submitKey} />
        <div className="notes-add-row">
          <span className="notes-hint"><code>**bold**</code> and <code>`code`</code> work</span>
          <button type="submit" className="quiet-button" disabled={adding || draft.trim() === ""}>Add note</button>
        </div>
      </form>
      {notes.length === 0 && <div className="more-empty">{`No notes on this ${words.project.toLowerCase()} yet.`}</div>}
      <ol className="notes-list">
        {newestFirst(notes).map((n) => (
          <li key={n.id} className="notes-entry">
            <time className="notes-date" dateTime={n.createdAt}>{n.createdAt.slice(0, 10)}</time>
            <NoteBody note={n} onEdit={onEdit} />
            <button type="button" className="close-button" aria-label="archive note" onClick={() => onArchive(n)}>×</button>
          </li>
        ))}
      </ol>
    </div>
  );
}

/**
 * One note, lockable, read until clicked and edited in place. A locked note reads "Locked" until
 * this device has the key; its saves go out sealed (LockableText) and the edit keeps the words it replaced.
 */
function NoteBody({ note, onEdit }: { readonly note: Note; readonly onEdit: NotesLogProps["onEdit"] }) {
  return (
    <LockableText kind="notes" id={note.id} field="body" value={note.body}
      save={(stored, was) => onEdit(note, stored, was ?? note.body)}>
      {(editor) => <NoteEditor text={editor.value ?? ""} onSave={editor.onSave} />}
    </LockableText>
  );
}

/** The click-to-edit text of one note; Ctrl or Cmd Enter or a click away saves. */
function NoteEditor({ text, onSave }: { readonly text: string; readonly onSave: SaveText }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(text);
  const commit = (): void => {
    const next = draft.trim();
    setEditing(false);
    if (next === "" || next === text.trim()) return;
    void Promise.resolve(onSave(next, text)).then((r) => {
      // A save that did not happen reopens the field with what was typed.
      if (!happened(r)) { setDraft(next); setEditing(true); }
    });
  };
  if (!editing) {
    return (
      <button type="button" dir="auto" className="editable notes-text" onClick={() => { setDraft(text); setEditing(true); }}>
        <NoteText text={text} />
      </button>
    );
  }
  return (
    <textarea dir="auto" className="editing notes-text" value={draft} rows={4} autoFocus aria-label="a note"
      onChange={(e) => setDraft(e.target.value)} onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Escape") { e.stopPropagation(); setDraft(text); setEditing(false); }
        else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); commit(); }
      }} />
  );
}

/** The notes log wired to the Worker: adds once per press, edits with undo, archives with the undo notice. */
export function ProjectNotes({ projectId }: { readonly projectId: string }) {
  const app = useApp();
  const notes = useResource<Note[]>(paths.list("notes", { project: projectId }));
  return (
    <NotesLog notes={notes.data ?? []}
      onAdd={(body) => app.act(createOnce("notes", { projectId, body }))}
      onEdit={(note, body, was) => app.edit("notes", note.id, { body }, { body: was }, "edited a note")}
      onArchive={(note) => void app.archive("notes", note.id, "note")} />
  );
}
