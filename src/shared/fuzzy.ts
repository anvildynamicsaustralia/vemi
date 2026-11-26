/**
 * Fuzzy match of typed text against a title, by words. Pure.
 *
 * Every typed word must start a word of the title or sit inside the title, in any order,
 * case blind. A word that starts a title word scores 2 and one that only sits inside
 * scores 1; the score is the sum. Empty text matches everything with 0.
 */

function words(text: string): string[] {
  return text
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length > 0);
}

/** The score of `typed` against `title`, or null when a typed word is nowhere in it. */
export function fuzzyScore(typed: string, title: string): number | null {
  const lower = title.toLowerCase();
  let score = 0;
  for (const w of words(typed)) {
    let best = 0;
    for (let at = lower.indexOf(w); at !== -1; at = lower.indexOf(w, at + 1)) {
      const starts = at === 0 || /[^\p{L}\p{N}]/u.test(lower.charAt(at - 1));
      if (starts) {
        best = 2;
        break;
      }
      best = 1;
    }
    if (best === 0) return null;
    score += best;
  }
  return score;
}

/** The rows that match, best first; equal scores keep their input order. */
export function fuzzyFilter<T>(
  rows: readonly T[],
  typed: string,
  title: (row: T) => string,
): T[] {
  const scored: { row: T; score: number; at: number }[] = [];
  rows.forEach((row, at) => {
    const score = fuzzyScore(typed, title(row));
    if (score !== null) scored.push({ row, score, at });
  });
  scored.sort((a, b) => b.score - a.score || a.at - b.at);
  return scored.map((s) => s.row);
}
