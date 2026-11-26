/**
 * Which way a venture's board is grouped, held between visits. Pure but for the two lines
 * that touch storage.
 *
 * **One key for every venture**, holding `{ ventureId: grouping }`, rather than a key each:
 * a namespace that grows a row per venture is one nobody ever clears, and there is no
 * settings store and no server-side preference record to put it in instead. The same
 * `"vemi:<thing>:v1"` shape the Space zoom and the last venture already use.
 *
 * Nothing here can throw and nothing here can answer with a grouping this build does not
 * have. A browser that refuses storage, a value edited by hand, a key left over from a
 * build that offered a fifth grouping: every one of them answers "state", which is the
 * default `decisions.md` holds to.
 */
import { GROUPINGS, type Grouping } from "./boardGroups.js";

const KEY = "vemi:board-group:v1";

/** State stays the default. */
const FIRST: Grouping = "state";

const isGrouping = (value: unknown): value is Grouping => GROUPINGS.some((g) => g === value);

/**
 * What the stored value says, whatever it turns out to be: an object of venture ids against
 * groupings, with every entry that is not one of those dropped.
 *
 * Built without a prototype, so a key like `__proto__` in a hand-edited value is an
 * ordinary entry rather than something the rest of the program reads back off `Object`.
 */
export function storedGroupings(raw: string | null): Record<string, Grouping> {
  const out = Object.create(null) as Record<string, Grouping>;
  if (raw === null) return out;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return out;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return out;
  for (const [id, grouping] of Object.entries(parsed as Record<string, unknown>)) {
    if (isGrouping(grouping)) out[id] = grouping;
  }
  return out;
}

/** The grouping one venture's board opens on, read out of a stored value. */
export function groupingIn(raw: string | null, ventureId: string): Grouping {
  return storedGroupings(raw)[ventureId] ?? FIRST;
}

/** The grouping this venture's board opens on. */
export function savedGrouping(ventureId: string): Grouping {
  try {
    return groupingIn(localStorage.getItem(KEY), ventureId);
  } catch {
    return groupingIn(null, ventureId);
  }
}

/** Hold this venture's choice, leaving every other venture's where it was. */
export function rememberGrouping(ventureId: string, grouping: Grouping): void {
  try {
    const held = { ...storedGroupings(localStorage.getItem(KEY)), [ventureId]: grouping };
    localStorage.setItem(KEY, JSON.stringify(held));
  } catch {
    // Remembered for this visit only.
  }
}
