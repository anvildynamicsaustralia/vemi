import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

// EditableText reads the save counter, which needs a browser store; a plain paragraph stands in for it.
vi.mock("./controls.js", async (original) => ({
  ...(await original<typeof import("./controls.js")>()),
  EditableText: ({ value }: { value: string | null }) => <p>{value}</p>,
}));

import type { Note } from "@vemi/shared";
import { NotesLog, newestFirst, type NotesLogProps } from "./ProjectNotes.js";
import { NoteText } from "./NoteText.js";
import { NoteLine } from "./NoteLine.js";
import { AppContext, type AppActions } from "./appContext.js";

const SEALED = `v1.${"A".repeat(11)}.${"B".repeat(16)}.${"C".repeat(40)}`;

const note = (id: string, body: string, createdAt: string, updatedAt = createdAt): Note =>
  ({ id, body, createdAt, updatedAt, archivedAt: null, ventureId: "v", projectId: "p" }) as Note;

const props = (notes: readonly Note[], over: Partial<NotesLogProps> = {}): NotesLogProps => ({
  notes, onAdd: () => undefined, onEdit: () => undefined, onArchive: () => undefined, ...over,
});

const html = (p: NotesLogProps): string => renderToStaticMarkup(<NotesLog {...p} />);

describe("newestFirst", () => {
  it("orders by createdAt, not by the last edit", () => {
    const older = note("a", "old", "2026-11-01T10:00:00Z", "2026-11-16T10:00:00Z");
    const newer = note("b", "new", "2026-11-10T10:00:00Z");
    expect(newestFirst([older, newer]).map((n) => n.id)).toEqual(["b", "a"]);
  });

  it("does not change the list it was given", () => {
    const list = [note("a", "x", "2026-11-01T00:00:00Z"), note("b", "y", "2026-11-02T00:00:00Z")];
    newestFirst(list);
    expect(list.map((n) => n.id)).toEqual(["a", "b"]);
  });
});

describe("NotesLog", () => {
  it("lists notes newest first with their dates", () => {
    const out = html(props([note("a", "First one", "2026-11-01T10:00:00Z"), note("b", "Second one", "2026-11-10T10:00:00Z")]));
    expect(out.indexOf("Second one")).toBeLessThan(out.indexOf("First one"));
    expect(out).toContain("2026-11-10");
    expect(out).toContain("2026-11-01");
  });

  it("shows the Add note button and the marker hint", () => {
    const out = html(props([]));
    expect(out).toContain("Add note");
    expect(out).toContain("<code>**bold**</code>");
    expect(out).toContain("<code>`code`</code>");
    expect(out).toContain("work");
  });

  it("draws bold and code as elements and the rest as text", () => {
    const out = html(props([note("a", "Email dropped. **Push only**, free. Stays on `anvil-core`", "2026-11-01T00:00:00Z")]));
    expect(out).toContain("<strong>Push only</strong>");
    expect(out).toContain("<code>anvil-core</code>");
  });

  it("shows typed HTML as text, never as markup", () => {
    const out = html(props([note("a", "<script>alert(1)</script> <b>x</b> [y](javascript:z)", "2026-11-01T00:00:00Z")]));
    expect(out).not.toContain("<script>");
    expect(out).not.toContain("<b>");
    expect(out).not.toContain("<a ");
    expect(out).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(out).toContain("&lt;b&gt;x&lt;/b&gt;");
    expect(out).toContain("[y](javascript:z)");
  });

  it("has an archive button on each note", () => {
    expect(html(props([note("a", "x", "2026-11-01T00:00:00Z")]))).toContain('aria-label="archive note"');
  });
});

describe("NoteText", () => {
  it("renders spans as text, strong and code", () => {
    const out = renderToStaticMarkup(<NoteText text="a **b** `c` <i>d</i>" />);
    expect(out).toContain("<strong>b</strong>");
    expect(out).toContain("<code>c</code>");
    expect(out).toContain("&lt;i&gt;d&lt;/i&gt;");
  });
});

describe("locked notes", () => {
  it("gives an open note a Lock button", () => {
    const out = html(props([note("a", "Plain words", "2026-11-01T00:00:00Z")]));
    expect(out).toContain("Plain words");
    expect(out).toContain('aria-label="Lock"');
  });

  it("never draws the envelope of a locked note, and still has its archive button", () => {
    const out = html(props([note("a", SEALED, "2026-11-01T00:00:00Z")]));
    expect(out).not.toContain(SEALED);
    expect(out).not.toContain("v1.");
    expect(out).toContain('aria-label="archive note"');
  });

  it("wraps a NoteLine the same way", () => {
    const app = { edit: () => undefined, archive: () => undefined } as unknown as AppActions;
    const draw = (n: Note): string => renderToStaticMarkup(<AppContext.Provider value={app}><NoteLine note={n} /></AppContext.Provider>);
    const open = draw(note("a", "Plain words", "2026-11-01T00:00:00Z"));
    expect(open).toContain("Plain words");
    expect(open).toContain('aria-label="Lock"');
    const locked = draw(note("b", SEALED, "2026-11-01T00:00:00Z"));
    expect(locked).not.toContain(SEALED);
    expect(locked).toContain('aria-label="archive note"');
  });
});
