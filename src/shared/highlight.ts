/**
 * Split a text into plain and matched parts for typed text. Pure.
 *
 * Each typed word is looked for case blind with plain string search, never a pattern, so
 * characters like `(` or `.*` mean only themselves. Overlapping and touching matches
 * merge. The parts always join back to the source.
 */

export interface HighlightPart {
  readonly text: string;
  readonly match: boolean;
}

export function highlight(text: string, typed: string): HighlightPart[] {
  if (text === "") return [];
  const lower = text.toLowerCase();
  const wanted = typed
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length > 0);
  // Some letters change length when lowered; then offsets would not line up, so show plain.
  if (wanted.length === 0 || lower.length !== text.length) return [{ text, match: false }];

  const ranges: [number, number][] = [];
  for (const w of wanted) {
    for (let at = lower.indexOf(w); at !== -1; at = lower.indexOf(w, at + w.length)) {
      ranges.push([at, at + w.length]);
    }
  }
  ranges.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged: [number, number][] = [];
  for (const r of ranges) {
    const last = merged[merged.length - 1];
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else merged.push([r[0], r[1]]);
  }

  const parts: HighlightPart[] = [];
  let cursor = 0;
  for (const [from, to] of merged) {
    if (from > cursor) parts.push({ text: text.slice(cursor, from), match: false });
    parts.push({ text: text.slice(from, to), match: true });
    cursor = to;
  }
  if (cursor < text.length) parts.push({ text: text.slice(cursor), match: false });
  return parts.length > 0 ? parts : [{ text, match: false }];
}
