/**
 * Note text as spans (VEMI-013, project page). A note allows `**bold**` and backtick code and
 * nothing else, so this returns data for React to draw as text, never an HTML string: a tag or a
 * link in a note comes back as plain characters. `renderMarkdown.ts` is the task-body grammar and
 * refuses emphasis and code on purpose, so notes get their own reader.
 */
export type NoteSpan =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "bold"; readonly text: string }
  | { readonly kind: "code"; readonly text: string };

const MARKS = [
  { open: "**", kind: "bold" },
  { open: "`", kind: "code" },
] as const;

export function noteMarkup(raw: string): NoteSpan[] {
  const spans: NoteSpan[] = [];
  let plain = "";
  const flush = (): void => {
    if (plain) spans.push({ kind: "text", text: plain });
    plain = "";
  };

  let i = 0;
  while (i < raw.length) {
    let matched = false;
    for (const mark of MARKS) {
      if (!raw.startsWith(mark.open, i)) continue;
      const from = i + mark.open.length;
      const end = raw.indexOf(mark.open, from);
      // An unclosed or empty pair is not markup; the marker stays text.
      if (end <= from) continue;
      flush();
      spans.push({ kind: mark.kind, text: raw.slice(from, end) });
      i = end + mark.open.length;
      matched = true;
      break;
    }
    if (!matched) {
      plain += raw[i];
      i += 1;
    }
  }
  flush();
  return spans;
}
