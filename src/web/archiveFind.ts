/**
 * Search's "Look in the Archive": what was typed is handed over, and the Archive opens with
 * its own field already holding it. Search leaves archived things out, so this is where a
 * search that found nothing goes next, before anyone makes the same task twice.
 *
 * One string, in memory only. The Archive reads it as it opens and lets it go once it has,
 * so a later visit opens empty, and a reload forgets it.
 */
let handed: string | null = null;

/** Hand this text to the Archive's field for its next opening. */
export function findInArchive(text: string): void {
  handed = text.trim() === "" ? null : text.trim();
}

/** What the Archive's field opens holding: what was handed over, or nothing. */
export function archiveFind(): string {
  return handed ?? "";
}

/** The Archive has opened with it: the next opening starts empty. */
export function archiveFound(): void {
  handed = null;
}
