/**
 * A venture's two letters, for the chip beside its name. Pure.
 *
 * No one rule suits every name: "Acme Studios" and "Acme Systems" both give AS from their
 * first two words. So the rule is the first two words' initials, and a venture whose pair is
 * already taken by one earlier in the order takes its first and last words' instead. Given
 * the order the map already keeps, the same ventures always get the same letters.
 */

interface Named {
  readonly id: string;
  readonly name: string;
  /** Letters the person set. Blank or absent means letters from the name. */
  readonly monogram?: string | null;
}

const words = (name: string): string[] =>
  name.split(/[\s\-_/·]+/).map((w) => w.replace(/[^\p{L}\p{N}]/gu, "")).filter((w) => w !== "");

const initial = (word: string | undefined): string => (word === undefined ? "" : [...word][0]?.toUpperCase() ?? "");

/** One name's letters, with no others to avoid. */
export function initials(name: string): string {
  const w = words(name);
  if (w.length === 0) return "·";
  if (w.length === 1) return [...(w[0] ?? "")].slice(0, 2).join("").toUpperCase();
  return initial(w[0]) + initial(w[1]);
}

/** Every venture's letters, in the order given, the later of two alike stepping aside. */
export function monograms(ventures: readonly Named[]): Map<string, string> {
  const out = new Map<string, string>();
  const taken = new Set<string>();
  for (const v of ventures) {
    const set = v.monogram?.trim() ?? "";
    if (set !== "") {
      out.set(v.id, set);
      taken.add(set);
      continue;
    }
    const first = initials(v.name);
    const w = words(v.name);
    const alternate = w.length > 2 ? initial(w[0]) + initial(w[w.length - 1]) : first;
    const mono = taken.has(first) && !taken.has(alternate) ? alternate : first;
    out.set(v.id, mono);
    taken.add(mono);
  }
  return out;
}

interface Placed extends Named {
  readonly position: number;
}

/**
 * Every venture's letters as the map's plates carry them: in position order, a tie broken by
 * id. The one place that order is written, so a plate and anything that echoes it — Recent,
 * under the field — can never letter a pair of alike names differently.
 */
export function mapLetters(ventures: readonly Placed[]): Map<string, string> {
  return monograms([...ventures].sort((a, b) => a.position - b.position || a.id.localeCompare(b.id)));
}
