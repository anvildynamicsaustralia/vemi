/**
 * A paste into an add line, as the items it means. Pure.
 *
 * A list copied from a note or an email arrives as lines. Flattened into one field it would
 * be one long title, so a paste of two or more lines that have words in them is one item a
 * line instead. A list's own marks go with the line they start: a bullet, a number, a tick
 * box, so "- [ ] Call Tommy" is "Call Tommy". One line, or none, is an ordinary paste.
 */

const MARK = /^(?:[-*+•–]\s+|\d+[.)]\s+)?(?:\[[ xX]\]\s+)?/;

/** The items a paste makes, or null when it is an ordinary paste of one line. */
export function pastedLines(text: string): string[] | null {
  const lines = text.split(/\r\n|\r|\n/).map((line) => line.trim().replace(MARK, "").trim()).filter((line) => line !== "");
  return lines.length < 2 ? null : lines;
}
